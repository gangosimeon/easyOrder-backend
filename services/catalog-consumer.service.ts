import { randomUUID } from 'node:crypto';
import type mongoose from 'mongoose';

import type { CatalogChangeEvent, CatalogChangePage } from '@/lib/geststock-client';
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
 * 2. Statuts terminaux (CURSOR_AHEAD, SNAPSHOT_REQUIRED, PAUSED, BLOCKED/UNKNOWN_EVENT) :
 *    aucun appel GestStock.
 * 3. BLOCKED/MISSING_CATEGORY : réessai au prochain cycle (appel GestStock depuis le dernier curseur).
 * 4. Les CATEGORY sont traités avant les PRODUCT dans chaque page.
 * 5. Idempotence par version : `external.version < version reçue` pour tout upsert.
 * 6. ARCHIVE PRODUCT : masquage `inStock=false`, version-conditionné ; jamais de suppression.
 * 7. ARCHIVE CATEGORY : curseur avancé (J10).
 * 8. PRODUCT_IMAGE, CHANNEL_PRICE, AVAILABILITY, ONLINE_ORDER_STATUS : curseur avancé.
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
const SKIP_TYPES = new Set(['PRODUCT_IMAGE', 'CHANNEL_PRICE', 'AVAILABILITY', 'ONLINE_ORDER_STATUS']);

/** Statuts terminaux : aucun appel GestStock. */
const TERMINAL_STATUSES = new Set(['CURSOR_AHEAD', 'SNAPSHOT_REQUIRED', 'PAUSED']);

export interface ConsumeInput {
  /** Identifiant de la liaison GestStock (UUID). */
  linkId: string;
  /** ObjectId MongoDB de la boutique associée à la liaison. */
  shopId: string;
  credentials: LinkCredentials;
}

/** Interface minimale requise pour la révocation locale de la liaison. */
export interface LinkRevoker {
  revoke(shopId: string, linkId: string, reason: string | null, revokedAt: Date): Promise<unknown>;
}

export class CatalogConsumerService {
  constructor(
    private readonly client: GeststockClient,
    private readonly linkRevoker: LinkRevoker = new GeststockLinkRepository(),
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
      if (acquired.status === 'BLOCKED' && acquired.blockedReason === 'UNKNOWN_EVENT') return;

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
    const categories = page.items.filter((e) => e.type === 'CATEGORY');
    const products   = page.items.filter((e) => e.type === 'PRODUCT');
    const others     = page.items.filter((e) => e.type !== 'CATEGORY' && e.type !== 'PRODUCT');

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
            $set: { status: 'BLOCKED', blockedReason: 'MISSING_CATEGORY', blockedEventSeq: event.seq },
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

    // Autres types
    for (const event of others) {
      if (!SKIP_TYPES.has(event.type)) {
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} : type inconnu « ${event.type} », curseur arrêté.`);
        await SyncState.updateOne({ linkId: input.linkId, leaseOwner }, {
          $set: { status: 'BLOCKED', blockedReason: 'UNKNOWN_EVENT', blockedEventSeq: event.seq },
        });
        return false;
      }
      // Type connu non traité ici (PRODUCT_IMAGE, CHANNEL_PRICE, etc.) : curseur avancé.
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
        $set: { inStock: false, 'external.version': event.version },
      }
    );
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
}

/** Instance partagée (utilise le client GestStock singleton du service de liaison). */
import { geststockClient } from '@/services/geststock-link.service';
export const catalogConsumerService = new CatalogConsumerService(geststockClient);
