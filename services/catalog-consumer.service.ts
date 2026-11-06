import type mongoose from 'mongoose';

import { CatalogChangePage, GeststockClient, GeststockError, LinkCredentials } from '@/lib/geststock-client';
import { Logger } from '@/lib/logger';
import { normalizeName } from '@/lib/normalize';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import SyncState, { AppliedEvent } from '@/models/syncstate.model';

/**
 * Consommateur du flux de catalogue GestStock (lot 3, J7 ; contrat `GET /catalog/changes`,
 * portée `catalog:read`).
 *
 * Règles d'application (par page) :
 * 1. Les événements CATEGORY sont traités avant les événements PRODUCT (dépendance
 *    catégorie → produit).
 * 2. Chaque événement est enregistré dans {@link AppliedEvent} avant d'être appliqué ;
 *    un E11000 (seq déjà présent) signifie que l'événement a déjà été appliqué → ignoré.
 *    Cette vérification garantit l'idempotence même sans transaction MongoDB (v13-D3).
 * 3. Pour les UPSERT, la mise à jour n'est effectuée que si `external.version < version
 *    reçue` : un événement plus ancien ne peut pas écraser une version plus récente.
 * 4. Pour les événements ARCHIVE et les types non pris en charge (lot J10 et versions
 *    futures), le seq est enregistré et le curseur avance sans rien écrire.
 * 5. `409 CURSOR_AHEAD` : le consommateur passe en statut CURSOR_AHEAD et s'arrête ;
 *    une réinitialisation manuelle est requise (v11-D11).
 */

export interface ConsumeInput {
  /** Identifiant de la liaison GestStock (UUID). */
  linkId: string;
  /** ObjectId MongoDB de la boutique associée à la liaison. */
  shopId: string;
  credentials: LinkCredentials;
}

export class CatalogConsumerService {
  constructor(private readonly client: GeststockClient) {}

  /**
   * Exécute un cycle de consommation pour la liaison : charge ou crée l'état de sync,
   * interroge le flux, applique les événements et avance le curseur. Si `hasMore`, répète
   * immédiatement jusqu'à épuisement.
   */
  async consume(input: ConsumeInput): Promise<void> {
    const state = await this.loadOrCreate(input.linkId);

    while (true) {
      let page: CatalogChangePage;
      try {
        page = await this.client.getCatalogChanges(input.credentials, state.after);
      } catch (err) {
        if (err instanceof GeststockError && err.kind === 'CURSOR_AHEAD') {
          Logger.warn(`Consommateur GestStock — liaison ${input.linkId} : CURSOR_AHEAD, synchronisation bloquée.`);
          await SyncState.updateOne({ linkId: input.linkId }, { $set: { status: 'CURSOR_AHEAD' } });
          return;
        }
        // Toute autre erreur (UNAVAILABLE, TIMEOUT, etc.) : statut ERROR, remontée
        await SyncState.updateOne({ linkId: input.linkId }, {
          $set: { status: 'ERROR', errorMessage: err instanceof Error ? err.message : 'Erreur inconnue' },
        });
        throw err;
      }

      await this.applyPage(input, page);

      // Avancer le curseur après application complète de la page
      state.after = page.lastSeq;
      await SyncState.updateOne({ linkId: input.linkId }, {
        $set: { after: page.lastSeq, status: 'IDLE' },
      });

      if (!page.hasMore) break;
    }
  }

  // --- Application d'une page ------------------------------------------------------------

  private async applyPage(input: ConsumeInput, page: CatalogChangePage): Promise<void> {
    // Séparer CATEGORY et PRODUCT, conserver les autres (types inconnus/non pris en charge)
    const categories = page.items.filter((e) => e.type === 'CATEGORY');
    const products = page.items.filter((e) => e.type === 'PRODUCT');
    const others = page.items.filter((e) => e.type !== 'CATEGORY' && e.type !== 'PRODUCT');

    // Traitement dans l'ordre : CATEGORY d'abord (les produits en dépendent)
    for (const event of categories) {
      await this.applyEvent(input, event, () => this.applyCategory(input.shopId, event));
    }
    for (const event of products) {
      await this.applyEvent(input, event, () => this.applyProduct(input.shopId, event));
    }
    // Types non pris en charge : curseur avancé via l'enregistrement dans AppliedEvent
    for (const event of others) {
      await this.registerApplied(input.linkId, event.seq);
    }
  }

  /**
   * Enregistre l'événement dans le registre puis appelle `apply` si ce n'est pas un doublon.
   * Un E11000 signifie que l'événement a déjà été appliqué : on continue sans erreur.
   */
  private async applyEvent(
    input: ConsumeInput,
    event: CatalogChangePage['items'][number],
    apply: () => Promise<void>,
  ): Promise<void> {
    const registered = await this.registerApplied(input.linkId, event.seq);
    if (!registered) return; // déjà appliqué

    if (event.operation === 'UPSERT' && event.data) {
      try {
        await apply();
      } catch (err) {
        Logger.warn(`Consommateur GestStock — liaison ${input.linkId}, seq ${event.seq} (${event.type}) : erreur d'application.`, err);
        // Pas de dépilage : le seq est déjà enregistré, l'erreur est journalisée
      }
    }
    // ARCHIVE : ignoré (J10) mais seq déjà enregistré
  }

  // --- Application d'un événement CATEGORY ----------------------------------------------

  private async applyCategory(shopId: string, event: CatalogChangePage['items'][number]): Promise<void> {
    const data = event.data as { name?: unknown; description?: unknown };
    const name = typeof data.name === 'string' ? data.name : '';
    const description = typeof data.description === 'string' ? data.description : '';

    // Essaie de mettre à jour un document existant si sa version est plus ancienne
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

    if (updated.matchedCount > 0) return; // mise à jour effectuée

    // Vérifie si le document existe déjà avec une version >= (ne rien faire)
    const exists = await Category.exists({ shopId, 'external.source': 'geststock', 'external.id': event.objectId });
    if (exists) return;

    // Création : peut échouer sur l'index unique normalizedName si le nom existe déjà
    // dans la boutique (rapprochement assisté, J11) ; dans ce cas, on journalise et on passe.
    try {
      await Category.create({
        shopId,
        name,
        normalizedName: normalizeName(name),
        description,
        external: { source: 'geststock', id: event.objectId, version: event.version },
      });
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 11000) {
        Logger.warn(
          `Consommateur GestStock — liaison, catégorie ${event.objectId} : conflit de nom normalisé, à rapprocher (J11).`
        );
        return;
      }
      throw err;
    }
  }

  // --- Application d'un événement PRODUCT -----------------------------------------------

  private async applyProduct(shopId: string, event: CatalogChangePage['items'][number]): Promise<void> {
    const data = event.data as {
      name?: unknown; description?: unknown; categoryId?: unknown;
      referencePrice?: unknown; unit?: unknown;
    };

    const name = typeof data.name === 'string' ? data.name : '';
    const description = typeof data.description === 'string' ? data.description : '';
    const unit = typeof data.unit === 'string' ? data.unit : '';
    const price = typeof data.referencePrice === 'string' ? parseFloat(data.referencePrice) : 0;

    // Résolution de la catégorie JCMB à partir de l'identifiant externe GestStock
    if (typeof data.categoryId !== 'string') return;
    const jcmbCategory = await Category.findOne({
      shopId,
      'external.source': 'geststock',
      'external.id': data.categoryId,
    }).lean<{ _id: mongoose.Types.ObjectId }>();
    if (!jcmbCategory) {
      Logger.warn(
        `Consommateur GestStock — produit ${event.objectId} : catégorie externe ${data.categoryId} introuvable, produit ignoré.`
      );
      return;
    }

    // Essaie de mettre à jour un document existant si sa version est plus ancienne
    const updated = await Product.updateOne(
      {
        shopId,
        'external.source': 'geststock',
        'external.id': event.objectId,
        'external.version': { $lt: event.version },
      },
      {
        $set: {
          name,
          description,
          price,
          unit,
          categoryId: jcmbCategory._id,
          'external.version': event.version,
        },
      }
    );

    if (updated.matchedCount > 0) return;

    const exists = await Product.exists({ shopId, 'external.source': 'geststock', 'external.id': event.objectId });
    if (exists) return;

    try {
      await Product.create({
        shopId,
        categoryId: jcmbCategory._id,
        name,
        description,
        price,
        unit,
        external: { source: 'geststock', id: event.objectId, version: event.version },
      });
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 11000) return; // doublon concurrentiel, ignoré
      throw err;
    }
  }

  // --- Registre des événements appliqués -------------------------------------------------

  /**
   * Enregistre le seq dans le registre d'idempotence.
   * @returns `true` si l'enregistrement a réussi (première application),
   *          `false` s'il existait déjà (E11000).
   */
  private async registerApplied(linkId: string, seq: number): Promise<boolean> {
    try {
      await AppliedEvent.create({ linkId, seq });
      return true;
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 11000) return false;
      throw err;
    }
  }

  // --- État de synchronisation -----------------------------------------------------------

  private async loadOrCreate(linkId: string) {
    let state = await SyncState.findOne({ linkId }).lean<{ after: number }>();
    if (!state) {
      await SyncState.create({ linkId, after: 0, status: 'IDLE' }).catch((err) => {
        // Concurrence : un autre processus a déjà créé l'état, on relit
        if ((err as { code?: number }).code !== 11000) throw err;
      });
      state = await SyncState.findOne({ linkId }).lean<{ after: number }>();
    }
    return state ?? { after: 0 };
  }
}

/** Instance partagée (utilise le client GestStock singleton du service de liaison). */
import { geststockClient } from '@/services/geststock-link.service';
export const catalogConsumerService = new CatalogConsumerService(geststockClient);
