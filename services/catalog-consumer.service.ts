import { randomUUID } from 'node:crypto';
import type mongoose from 'mongoose';

import type { CatalogChangeEvent, CatalogChangePage, ProductImageResult, SnapshotPage } from '@/lib/geststock-client';
import { GeststockClient, GeststockError, LinkCredentials } from '@/lib/geststock-client';
import { Logger } from '@/lib/logger';
import { normalizeName } from '@/lib/normalize';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import SyncState from '@/models/syncstate.model';
import { GeststockLinkRepository } from '@/repositories/geststock-link.repository';

/**
 * Consommateur du flux de catalogue GestStock (lot 3, J7b ; contrat `GET /catalog/changes`,
 * portée `catalog:read`).
 *
 * Règles d'application :
 * 1. Bail d'exclusion (`leaseOwner` + `leaseUntil`) : un seul consommateur à la fois par liaison.
 * 2. Statuts terminaux (CURSOR_AHEAD, PAUSED, BLOCKED/UNKNOWN_EVENT, BLOCKED/CURRENCY_MISMATCH) :
 *    aucun appel GestStock.
 * 3. BLOCKED/MISSING_CATEGORY : instantané automatique unique (D7) ; si blocage persistant après instantané → reste BLOCKED.
 * 4. Les CATEGORY sont traités avant les PRODUCT dans chaque page.
 * 5. Idempotence par version : `external.version < version reçue` pour tout upsert.
 * 6. ARCHIVE PRODUCT : masquage `visibleInShop=false`, version-conditionné ; `inStock` non touché ; jamais de suppression.
 * 7. ARCHIVE CATEGORY : curseur avancé (J10).
 * 8. PRODUCT_IMAGE : empreinte SHA-256 (`imageSha256`) enregistrée sur le produit (version-conditionné) ;
 *    curseur toujours avancé. Téléchargement différé dans `consumeImages()` (J9).
 *    CHANNEL_PRICE, AVAILABILITY, ONLINE_ORDER_STATUS : curseur avancé.
 * 9. Type inconnu : BLOCKED/UNKNOWN_EVENT, curseur arrêté.
 * 10. `price` : posé seulement à la création ; `externalPrice` mis à jour à chaque version.
 * 11. Accusé de réception (`POST /catalog/changes/ack`) : après le dernier curseur sauvegardé ;
 *     échec = réessai au prochain cycle.
 * 12. Erreurs :
 *     - 409 CURSOR_AHEAD → statut CURSOR_AHEAD (terminal).
 *     - 410 CURSOR_EXPIRED → statut SNAPSHOT_REQUIRED (terminal).
 *     - LINK_REVOKED → révocation locale de la liaison, état sync supprimé.
 *     - 403 LINK_SUSPENDED / COMPANY_SUSPENDED → statut PAUSED (terminal).
 *     - 429 RATE_LIMITED → `nextAttemptAt` selon Retry-After.
 *     - 503 / réseau → `nextAttemptAt` (délai fixe).
 */

/** Durée du bail (ms) : couvre un cycle de pages avec marge. */
const LEASE_DURATION_MS = 30_000;

/** Délai minimal de réessai sur erreur transitoire (ms). */
const RETRY_DELAY_MS = 5 * 60_000;

/** Types dont le curseur avance sans traitement (lots futurs ou déjà gérés ailleurs). */
const SKIP_TYPES = new Set(['CHANNEL_PRICE', 'AVAILABILITY', 'ONLINE_ORDER_STATUS']);

/** Statuts terminaux : aucun appel GestStock (hors SNAPSHOT_REQUIRED géré par consumeSnapshot). */
const TERMINAL_STATUSES = new Set(['CURSOR_AHEAD', 'PAUSED']);

export interface ConsumeInput {
  /** Identifiant de la liaison GestStock (UUID). */
  linkId: string;
  /** ObjectId MongoDB de la boutique associée à la liaison. */
  shopId: string;
  credentials: LinkCredentials;
  /** Devise ISO 4217 attendue pour la validation des pages d'instantané (lot 3, J8b, D4). */
  expectedCurrency?: string;
}

/** Interface minimale requise pour la révocation locale de la liaison. */
export interface LinkRevoker {
  revoke(shopId: string, linkId: string, reason: string | null, revokedAt: Date): Promise<unknown>;
}

/**
 * Stockage d'une image téléchargée depuis GestStock (lot 3, J9).
 * L'implémentation de production upload sur Cloudinary ; les tests injectent un mock.
 */
export interface ProductImageStore {
  /** Enregistre l'image JPEG et renvoie l'URL publique. */
  upload(externalProductId: string, data: Buffer): Promise<string>;
}

export class CatalogConsumerService {
  constructor(
    private readonly client: GeststockClient,
    private readonly linkRevoker: LinkRevoker = new GeststockLinkRepository(),
    private readonly imageStore?: ProductImageStore,
  ) {}

  /**
   * Exécute un cycle de consommation pour la liaison : acquiert le bail, vérifie le statut,
   * interroge le flux, applique les événements, avance le curseur et envoie l'accusé.
   */
  async consume(input: ConsumeInput): Promise<void> {
    const leaseOwner = randomUUID();
    const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS);

    // --- 1. Acquérir le bail (ou créer l'état) -------------------------------------------
    let acquired: {
      after: number; acknowledgedSeq: number; status: string;
      blockedReason?: string | null; nextAttemptAt?: Date | null;
      blockedAutoSnapshotDone?: boolean | null;
    } | null;
    try {
      acquired = await SyncState.findOneAndUpdate(
        {
          linkId: input.linkId,
          $or: [
            { leaseOwner: null },
            { leaseOwner: { $exists: false } },
            { leaseUntil: { $lt: new Date() } },
          ],
        },
        {
          $set: { leaseOwner, leaseUntil },
          $setOnInsert: { after: 0, acknowledgedSeq: 0, status: 'IDLE', blockedReason: null, blockedEventSeq: null, nextAttemptAt: null },
        },
        { upsert: true, new: true }
      ).lean();
    } catch (err) {
      // E11000 : un document avec ce linkId existe déjà et a un bail actif.
      if ((err as { code?: number }).code === 11000) return;
      throw err;
    }
    if (!acquired) return;

    const state = { after: acquired.after, acknowledgedSeq: acquired.acknowledgedSeq };

    try {
      // --- 2. Statuts terminaux → aucun appel GestStock -----------------------------------
      if (TERMINAL_STATUSES.has(acquired.status)) return;
      if (acquired.status === 'BLOCKED') {
        const r = acquired.blockedReason;
        if (r === 'UNKNOWN_EVENT' || r === 'CURRENCY_MISMATCH') return;
        if (r === 'MISSING_CATEGORY') {
          if (acquired.blockedAutoSnapshotDone) {
            // Instantané déjà tenté pour cet incident : blocage persistant, intervention manuelle requise.
            Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : MISSING_CATEGORY non résolu après instantané automatique — intervention manuelle requise.`);
            return;
          }
          // D7 : instantané automatique unique par incident MISSING_CATEGORY.
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
            $set: { blockedAutoSnapshotDone: true },
          });
          await this.consumeSnapshot(input, leaseOwner, state);
          return;
        }
        // Raison inconnue : réessai au prochain cycle.
      }

      // --- 2b. Instantané requis (J8) → consumeSnapshot au lieu du flux -------------------
      if (acquired.status === 'SNAPSHOT_REQUIRED') {
        await this.consumeSnapshot(input, leaseOwner, state);
        return;
      }

      // --- 3. Backoff actif → trop tôt ----------------------------------------------------
      if (acquired.nextAttemptAt && acquired.nextAttemptAt > new Date()) return;

      // --- 4. Passer en SYNCING -----------------------------------------------------------
      await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
        $set: { status: 'SYNCING', blockedReason: null, blockedEventSeq: null, nextAttemptAt: null },
      });

      // --- 5. Consommer les pages ---------------------------------------------------------
      let blocked = false;
      while (true) {
        let page: CatalogChangePage;
        try {
          page = await this.client.getCatalogChanges(input.credentials, state.after);
        } catch (err) {
          await this.handleFetchError(input, err, leaseOwner);
          return;
        }

        const applied = await this.applyPage(input, page, leaseOwner);
        if (!applied) {
          blocked = true;
          break;
        }

        // Avancer le curseur après application complète de la page
        state.after = page.lastSeq;
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { after: page.lastSeq },
        });

        if (!page.hasMore) break;

        // Renouveler le bail avant la prochaine page
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { leaseUntil: new Date(Date.now() + LEASE_DURATION_MS) },
        });
      }

      if (blocked) return;

      // --- 6. Accusé de réception ---------------------------------------------------------
      if (state.after > state.acknowledgedSeq) {
        try {
          await this.client.acknowledgeChanges(input.credentials, state.after);
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
            $set: { acknowledgedSeq: state.after },
          });
          state.acknowledgedSeq = state.after;
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : accusé de réception échoué (${(err as Error)?.message ?? err}), réessai au prochain cycle.`);
        }
      }

      // --- 7. Passer en IDLE -------------------------------------------------------------
      await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
        $set: { status: 'IDLE' },
      });
    } finally {
      // Libérer le bail (sans effet si l'état a été supprimé sur LINK_REVOKED)
      await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
        $set: { leaseOwner: null, leaseUntil: null },
      });
    }
  }

  // --- Application d'une page -----------------------------------------------------------

  /** @returns `true` si la page a été appliquée entièrement, `false` si BLOCKED. */
  private async applyPage(input: ConsumeInput, page: CatalogChangePage, leaseOwner: string): Promise<boolean> {
    const categories    = page.items.filter((e) => e.type === 'CATEGORY');
    const products      = page.items.filter((e) => e.type === 'PRODUCT');
    const productImages = page.items.filter((e) => e.type === 'PRODUCT_IMAGE');
    const others        = page.items.filter((e) => e.type !== 'CATEGORY' && e.type !== 'PRODUCT' && e.type !== 'PRODUCT_IMAGE');

    // CATEGORY en premier (les PRODUCT en dépendent)
    for (const event of categories) {
      if (event.operation === 'UPSERT' && event.data) {
        try {
          await this.applyCategory(input.shopId, event);
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} (CATEGORY) : erreur d'application (${(err as Error)?.message ?? err}).`);
        }
      }
      // ARCHIVE CATEGORY : curseur avancé (J10)
    }

    // PRODUCT
    for (const event of products) {
      if (event.operation === 'UPSERT' && event.data) {
        const result = await this.applyProductUpsert(input.shopId, event);
        if (result === 'MISSING_CATEGORY') {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} : catégorie externe ${(event.data as { categoryId?: unknown }).categoryId} introuvable, curseur arrêté.`);
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
            $set: { status: 'BLOCKED', blockedReason: 'MISSING_CATEGORY', blockedEventSeq: event.seq, blockedAutoSnapshotDone: false },
          });
          return false;
        }
      } else if (event.operation === 'ARCHIVE') {
        try {
          await this.archiveProduct(input.shopId, event);
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} (PRODUCT ARCHIVE) : erreur (${(err as Error)?.message ?? err}).`);
        }
      }
    }

    // PRODUCT_IMAGE : empreinte enregistrée version-conditionnée ; curseur toujours avancé
    for (const event of productImages) {
      if (event.operation === 'UPSERT' && event.data) {
        try {
          await this.applyProductImageState(input.shopId, event);
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} (PRODUCT_IMAGE) : erreur (${(err as Error)?.message ?? err}).`);
        }
      }
    }

    // Autres types
    for (const event of others) {
      if (!SKIP_TYPES.has(event.type)) {
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} : type inconnu « ${event.type} », curseur arrêté.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'BLOCKED', blockedReason: 'UNKNOWN_EVENT', blockedEventSeq: event.seq },
        });
        return false;
      }
      // Type connu non traité ici (CHANNEL_PRICE, etc.) : curseur avancé.
    }

    return true;
  }

  // --- CATEGORY --------------------------------------------------------------------------

  private async applyCategory(shopId: string, event: CatalogChangeEvent): Promise<void> {
    const data = event.data as { name?: unknown; description?: unknown };
    const name = typeof data.name === 'string' ? data.name : '';
    const description = typeof data.description === 'string' ? data.description : '';

    const updated = await Category.updateOne(
      {
        shopId,
        'external.source': 'geststock',
        'external.id': event.objectId,
        'external.version': { $lt: event.version },
      },
      {
        $set: {
          name,
          normalizedName: normalizeName(name),
          description,
          'external.version': event.version,
        },
      }
    );
    if (updated.matchedCount > 0) return;

    const exists = await Category.exists({ shopId, 'external.source': 'geststock', 'external.id': event.objectId });
    if (exists) return;

    try {
      await Category.create({
        shopId, name, normalizedName: normalizeName(name), description,
        external: { source: 'geststock', id: event.objectId, version: event.version },
      });
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 11000) {
        Logger.warn(`Consommateur GestStock — catégorie ${event.objectId} : conflit de nom normalisé, à rapprocher (J11).`);
        return;
      }
      throw err;
    }
  }

  // --- PRODUCT UPSERT --------------------------------------------------------------------

  /** @returns `'MISSING_CATEGORY'` si la catégorie externe est introuvable, `'ok'` sinon. */
  private async applyProductUpsert(shopId: string, event: CatalogChangeEvent): Promise<'ok' | 'MISSING_CATEGORY'> {
    const data = event.data as {
      name?: unknown; description?: unknown; categoryId?: unknown;
      referencePrice?: unknown; unit?: unknown;
    };

    if (typeof data.categoryId !== 'string') return 'MISSING_CATEGORY';

    const jcmbCategory = await Category.findOne({
      shopId,
      'external.source': 'geststock',
      'external.id': data.categoryId,
    }).lean<{ _id: mongoose.Types.ObjectId }>();
    if (!jcmbCategory) return 'MISSING_CATEGORY';

    const name = typeof data.name === 'string' ? data.name : '';
    const description = typeof data.description === 'string' ? data.description : '';
    const unit = typeof data.unit === 'string' ? data.unit : '';
    const externalPrice = typeof data.referencePrice === 'string' ? parseFloat(data.referencePrice) : 0;

    // Mise à jour version-conditionnée : `price` non touché (prix boutique)
    const updated = await Product.updateOne(
      {
        shopId,
        'external.source': 'geststock',
        'external.id': event.objectId,
        'external.version': { $lt: event.version },
      },
      {
        $set: {
          name, description, unit,
          categoryId: jcmbCategory._id,
          externalPrice,
          visibleInShop: true,
          'external.version': event.version,
        },
      }
    );
    if (updated.matchedCount > 0) return 'ok';

    const exists = await Product.exists({ shopId, 'external.source': 'geststock', 'external.id': event.objectId });
    if (exists) return 'ok';

    try {
      await Product.create({
        shopId, categoryId: jcmbCategory._id, name, description, unit,
        price: externalPrice,
        externalPrice,
        external: { source: 'geststock', id: event.objectId, version: event.version },
      });
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 11000) return 'ok'; // doublon concurrentiel
      throw err;
    }
    return 'ok';
  }

  // --- PRODUCT ARCHIVE -------------------------------------------------------------------

  private async archiveProduct(shopId: string, event: CatalogChangeEvent): Promise<void> {
    await Product.updateOne(
      {
        shopId,
        'external.source': 'geststock',
        'external.id': event.objectId,
        'external.version': { $lt: event.version },
      },
      {
        $set: { visibleInShop: false, 'external.version': event.version },
      }
    );
  }

  // --- PRODUCT_IMAGE (J9) ----------------------------------------------------------------

  /**
   * Enregistre l'empreinte SHA-256 d'un événement `PRODUCT_IMAGE` sur le produit local,
   * version-conditionné (`imageVersion < version reçue`). Le téléchargement effectif de
   * l'image est délégué à `consumeImages()`.
   *
   * - `imageSha256 = null` : retrait d'image, champ effacé.
   * - Idempotent : version identique ou plus ancienne ignorée.
   */
  private async applyProductImageState(shopId: string, event: CatalogChangeEvent): Promise<void> {
    const data = event.data as { productId?: unknown; imageSha256?: unknown; version?: unknown };
    const externalId = typeof data.productId === 'string' ? data.productId : event.objectId;
    const imageSha256 = typeof data.imageSha256 === 'string' ? data.imageSha256 : null;
    const version = typeof data.version === 'number' ? data.version : event.version;

    await Product.updateOne(
      {
        shopId,
        'external.source': 'geststock',
        'external.id': externalId,
        $or: [
          { imageVersion: null },
          { imageVersion: { $exists: false } },
          { imageVersion: { $lt: version } },
        ],
      },
      {
        $set: { imageSha256, imageVersion: version },
        // Effacer l'ETag si l'empreinte change (forcer le téléchargement au prochain consumeImages)
        ...(imageSha256 === null ? { $unset: { imageETag: '' } } : {}),
      }
    );
  }

  // --- Téléchargement des images (J9) ---------------------------------------------------

  /**
   * Télécharge les images des produits GestStock dont l'empreinte a changé depuis la dernière
   * synchronisation (`imageSha256` présent, `imageETag` absent ou différent de `imageSha256`).
   *
   * Chaque image est téléchargée via `GET /catalog/products/{id}/image` (G19) :
   * - `If-None-Match` envoyé avec l'ETag détenu (G19-D9) → `304` : rien à faire.
   * - `200` : image JPEG stockée via `imageStore`, ETag reçu enregistré.
   * - `404` : pas d'image, `imageSha256` et `imageETag` effacés.
   * - `429` : `imageNextAttemptAt` posé, arrêt du cycle d'images.
   * - Erreur transitoire : arrêt silencieux, réessai au prochain cycle.
   *
   * Ne partage pas le bail du consommateur de flux : appelé dans un cycle séparé.
   * Sans `imageStore` injecté, les octets sont ignorés (empreinte et ETag quand même enregistrés).
   */
  async consumeImages(input: ConsumeInput): Promise<void> {
    // Backoff images actif ?
    const state = await SyncState.findOne({ linkId: input.linkId }).lean();
    if (!state) return;
    if (state.imageNextAttemptAt && state.imageNextAttemptAt > new Date()) return;

    // Produits GestStock dont l'empreinte est connue mais l'ETag ne correspond pas
    const products = await Product.find({
      shopId: input.shopId,
      'external.source': 'geststock',
      imageSha256: { $ne: null, $exists: true },
    }).select('external.id imageSha256 imageETag').lean();

    for (const prod of products) {
      const externalId = prod.external?.id;
      if (!externalId) continue;
      const knownSha = prod.imageSha256 as string | null;
      const knownETag = prod.imageETag as string | null;

      // ETag identique à l'empreinte connue → déjà à jour
      if (knownSha && knownETag === knownSha) continue;

      let result: ProductImageResult;
      try {
        result = await this.client.getCatalogProductImage(input.credentials, externalId, knownETag);
      } catch (err) {
        if (err instanceof GeststockError && err.kind === 'RATE_LIMITED') {
          const delay = (err.details.retryAfterSeconds ?? 60) * 1000;
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : 429 (images), réessai différé.`);
          await SyncState.updateOne({ linkId: input.linkId }, {
            $set: { imageNextAttemptAt: new Date(Date.now() + delay) },
          });
          return;
        }
        // Erreur transitoire ou LINK_REVOKED : arrêt silencieux, réessai au prochain cycle
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, image ${externalId} : erreur (${(err as Error)?.message ?? err}).`);
        return;
      }

      if (result.kind === 'not_modified') continue;

      if (result.kind === 'not_found') {
        await Product.updateOne(
          { shopId: input.shopId, 'external.source': 'geststock', 'external.id': externalId },
          { $set: { imageSha256: null, imageVersion: null, imageETag: null } }
        );
        continue;
      }

      // result.kind === 'image'
      let imageUrl: string | undefined;
      if (this.imageStore) {
        try {
          imageUrl = await this.imageStore.upload(externalId, result.data);
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, image ${externalId} : stockage échoué (${(err as Error)?.message ?? err}).`);
        }
      }
      await Product.updateOne(
        { shopId: input.shopId, 'external.source': 'geststock', 'external.id': externalId },
        {
          $set: {
            imageETag: result.etag,
            ...(imageUrl ? { image: imageUrl } : {}),
          },
        }
      );
    }
  }

  // --- Gestion des erreurs de l'appel GestStock ------------------------------------------

  private async handleFetchError(input: ConsumeInput, err: unknown, leaseOwner: string): Promise<void> {
    if (!(err instanceof GeststockError)) {
      Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : erreur inattendue (${(err as Error)?.message ?? err}).`);
      await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
        $set: { status: 'IDLE', nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
      });
      return;
    }

    switch (err.kind) {
      case 'CURSOR_AHEAD':
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : CURSOR_AHEAD, synchronisation bloquée.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, { $set: { status: 'CURSOR_AHEAD' } });
        break;

      case 'CURSOR_EXPIRED':
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : CURSOR_EXPIRED, instantané requis.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, { $set: { status: 'SNAPSHOT_REQUIRED' } });
        break;

      case 'LINK_REVOKED':
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : LINK_REVOKED, révocation locale.`);
        await this.linkRevoker.revoke(input.shopId, input.linkId, null, new Date());
        await SyncState.deleteOne({ linkId: input.linkId });
        break;

      case 'REJECTED':
        if (err.details.code === 'LINK_SUSPENDED' || err.details.code === 'COMPANY_SUSPENDED') {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : ${err.details.code}, mise en pause.`);
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, { $set: { status: 'PAUSED' } });
        } else {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : REJECTED (${err.details.status}, ${err.details.code}).`);
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
            $set: { status: 'IDLE', nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
          });
        }
        break;

      case 'RATE_LIMITED': {
        const delay = (err.details.retryAfterSeconds ?? 60) * 1000;
        const nextAttemptAt = new Date(Date.now() + delay);
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : 429, réessai à ${nextAttemptAt.toISOString()}.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'IDLE', nextAttemptAt },
        });
        break;
      }

      default:
        // UNAVAILABLE, TIMEOUT, NETWORK, PROTOCOL…
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : ${err.kind}, réessai différé.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'IDLE', nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
        });
        break;
    }
  }

  // --- Instantané complet (J8) -----------------------------------------------------------

  /**
   * Consomme l'instantané complet du catalogue (`GET /catalog/snapshot`) quand
   * le statut est SNAPSHOT_REQUIRED. Les sections sont ordonnées CATEGORIES → PRODUCTS :
   * les catégories sont garanties présentes quand les produits arrivent.
   *
   * Après l'instantané : réconciliation (produits GestStock absents → `visibleInShop=false`),
   * curseur posé à `asOfSeq`, statut IDLE, accusé de réception envoyé.
   */
  private async consumeSnapshot(
    input: ConsumeInput,
    leaseOwner: string,
    state: { after: number; acknowledgedSeq: number },
  ): Promise<void> {
    // D3 : effacer le blocage précédent et passer en SYNCING
    await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
      $set: { status: 'SYNCING', nextAttemptAt: null, blockedReason: null, blockedEventSeq: null },
    });

    // Réconciliation des catégories : J10
    const seenCategoryIds = new Set<string>();
    const seenProductIds  = new Set<string>();
    let pageToken: string | undefined;
    let asOfSeq: number | undefined;
    let pageCurrency: string | undefined;

    while (true) {
      let page: SnapshotPage;
      try {
        page = await this.client.getSnapshot(input.credentials, pageToken);
      } catch (err) {
        await this.handleSnapshotError(input, err, leaseOwner);
        return;
      }

      if (asOfSeq === undefined) asOfSeq = page.asOfSeq;

      // D4 : vérifier la devise sur chaque page (cohérence inter-pages et conformité à la liaison)
      if (pageCurrency === undefined) {
        pageCurrency = page.currency;
      } else if (page.currency !== pageCurrency) {
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : devise incohérente entre pages (« ${pageCurrency} » puis « ${page.currency} ») — CURRENCY_MISMATCH.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'BLOCKED', blockedReason: 'CURRENCY_MISMATCH', blockedEventSeq: null },
        });
        return;
      }
      if (input.expectedCurrency && page.currency !== input.expectedCurrency) {
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : devise « ${page.currency} » ≠ devise attendue « ${input.expectedCurrency} » — CURRENCY_MISMATCH.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'BLOCKED', blockedReason: 'CURRENCY_MISMATCH', blockedEventSeq: null },
        });
        return;
      }

      // Catégories en premier (garanties avant les produits par l'ordre des sections GestStock)
      for (const item of page.categories) {
        const id = typeof item.id === 'string' ? item.id : '';
        if (id) seenCategoryIds.add(id);
        try {
          await this.applyCategory(input.shopId, snapshotItemToEvent('CATEGORY', item));
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, instantané CATEGORY ${id} : erreur d'application (${(err as Error)?.message ?? err}).`);
        }
      }

      // Produits
      for (const item of page.products) {
        const id = typeof item.id === 'string' ? item.id : '';
        if (id) seenProductIds.add(id);
        const result = await this.applyProductUpsert(input.shopId, snapshotItemToEvent('PRODUCT', item));
        if (result === 'MISSING_CATEGORY') {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, instantané PRODUCT ${id} : catégorie externe introuvable, ignoré (J11).`);
        }
      }

      // État des images (J9) : empreinte SHA-256 enregistrée version-conditionnée
      for (const item of page.productImages) {
        const imageEvent = snapshotItemToEvent('PRODUCT_IMAGE', item);
        // Dans l'instantané, objectId = productId (ProductImageState.productId)
        if (typeof item.productId === 'string') imageEvent.objectId = item.productId;
        try {
          await this.applyProductImageState(input.shopId, imageEvent);
        } catch (err) {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, instantané PRODUCT_IMAGE ${imageEvent.objectId} : erreur (${(err as Error)?.message ?? err}).`);
        }
      }

      // Renouveler le bail avant la prochaine page
      await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
        $set: { leaseUntil: new Date(Date.now() + LEASE_DURATION_MS) },
      });

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    // D1 : réconciliation sans garde — masquer tous les produits GestStock absents de l'instantané
    const reconResult = await Product.updateMany(
      {
        shopId: input.shopId,
        'external.source': 'geststock',
        'external.id': { $nin: Array.from(seenProductIds) },
        visibleInShop: { $ne: false },
      },
      { $set: { visibleInShop: false } }
    );
    if (reconResult.modifiedCount > 0) {
      Logger.info(`Consommateur GestStock — liaison ${input.linkId} : réconciliation, ${reconResult.modifiedCount} produit(s) masqué(s).`);
    }

    // D3 : curseur posé à asOfSeq ; statut IDLE ; blocage effacé
    const finalSeq = asOfSeq ?? 0;
    await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
      $set: { after: finalSeq, status: 'IDLE', blockedReason: null, blockedEventSeq: null, blockedAutoSnapshotDone: null },
    });
    state.after = finalSeq;

    if (finalSeq > state.acknowledgedSeq) {
      try {
        await this.client.acknowledgeChanges(input.credentials, finalSeq);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { acknowledgedSeq: finalSeq },
        });
      } catch (err) {
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : accusé de réception (instantané) échoué (${(err as Error)?.message ?? err}), réessai au prochain cycle.`);
      }
    }
  }

  /**
   * Gestion des erreurs lors de la consommation de l'instantané.
   * Les erreurs transitoires laissent le statut SNAPSHOT_REQUIRED pour relance.
   */
  private async handleSnapshotError(input: ConsumeInput, err: unknown, leaseOwner: string): Promise<void> {
    if (!(err instanceof GeststockError)) {
      Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : erreur inattendue durant l'instantané (${(err as Error)?.message ?? err}).`);
      await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
        $set: { status: 'SNAPSHOT_REQUIRED', nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
      });
      return;
    }

    switch (err.kind) {
      case 'SNAPSHOT_EXPIRED':
        // Jeton de page expiré (> 24 h) : reprendre depuis la page 1 au prochain cycle
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : jeton d'instantané expiré, reprise au prochain cycle.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, { $set: { status: 'SNAPSHOT_REQUIRED' } });
        break;

      case 'LINK_REVOKED':
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : LINK_REVOKED (instantané), révocation locale.`);
        await this.linkRevoker.revoke(input.shopId, input.linkId, null, new Date());
        await SyncState.deleteOne({ linkId: input.linkId });
        break;

      case 'REJECTED':
        if (err.details.code === 'LINK_SUSPENDED' || err.details.code === 'COMPANY_SUSPENDED') {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : ${err.details.code} (instantané), mise en pause.`);
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, { $set: { status: 'PAUSED' } });
        } else {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : REJECTED (instantané, ${err.details.status}, ${err.details.code}).`);
          await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
            $set: { status: 'SNAPSHOT_REQUIRED', nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
          });
        }
        break;

      case 'RATE_LIMITED': {
        const delay = (err.details.retryAfterSeconds ?? 60) * 1000;
        const nextAttemptAt = new Date(Date.now() + delay);
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : 429 (instantané), réessai à ${nextAttemptAt.toISOString()}.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'SNAPSHOT_REQUIRED', nextAttemptAt },
        });
        break;
      }

      default:
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : ${err.kind} (instantané), réessai différé.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'SNAPSHOT_REQUIRED', nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
        });
        break;
    }
  }
}

/** Convertit un élément d'instantané en événement UPSERT pour les fonctions d'application. */
function snapshotItemToEvent(type: string, item: Record<string, unknown>): CatalogChangeEvent {
  return {
    seq: 0,
    type,
    objectId: typeof item.id === 'string' ? item.id : '',
    version: typeof item.version === 'number' ? item.version : 0,
    operation: 'UPSERT',
    occurredAt: new Date().toISOString(),
    data: item,
  };
}

/** Instance partagée (utilise le client GestStock singleton du service de liaison). */
import { geststockClient } from '@/services/geststock-link.service';
export const catalogConsumerService = new CatalogConsumerService(geststockClient);
