import { beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import SyncState from '@/models/syncstate.model';
import { CatalogConsumerService, type ConsumeInput, type LinkRevoker } from '@/services/catalog-consumer.service';
import type { CatalogChangePage, SnapshotPage, GeststockClient } from '@/lib/geststock-client';

/**
 * Consommateur du flux de catalogue GestStock (lot 3, J7b) :
 * bail d'exclusion, idempotence par version, BLOCKED/MISSING_CATEGORY, ARCHIVE,
 * types non pris en charge, accusé de réception, statuts d'erreur.
 */

/** Crée un service avec un client GestStock simulé (flux de modifications). */
function makeService(pages: CatalogChangePage[], linkRevoker?: LinkRevoker) {
  let callCount = 0;
  const mockGetChanges = vi.fn(async () => {
    return pages[callCount++] ?? { items: [], hasMore: false, lastSeq: 0 };
  });
  const mockAck = vi.fn(async (_creds: unknown, seq: number) => ({ acknowledgedSeq: seq }));
  const client = {
    getCatalogChanges: mockGetChanges,
    acknowledgeChanges: mockAck,
    getSnapshot: vi.fn(async () => ({ asOfSeq: 0, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null })),
  } as unknown as GeststockClient;
  return { service: new CatalogConsumerService(client, linkRevoker), mockGetChanges, mockAck };
}

/** Crée un service avec un client GestStock simulé (instantané). */
function makeSnapshotService(pages: SnapshotPage[], linkRevoker?: LinkRevoker) {
  let callCount = 0;
  const mockGetSnapshot = vi.fn(async () => {
    return pages[callCount++] ?? { asOfSeq: 0, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null };
  });
  const mockAck = vi.fn(async (_creds: unknown, seq: number) => ({ acknowledgedSeq: seq }));
  const client = {
    getCatalogChanges: vi.fn(async () => { throw new Error('getCatalogChanges ne doit pas être appelé'); }),
    acknowledgeChanges: mockAck,
    getSnapshot: mockGetSnapshot,
  } as unknown as GeststockClient;
  return { service: new CatalogConsumerService(client, linkRevoker), mockGetSnapshot, mockAck };
}

/** linkId et input uniques par test pour éviter toute interférence entre états. */
function makeTest() {
  const linkId = 'link-' + new mongoose.Types.ObjectId().toString();
  return {
    linkId,
    input(shopId: string): ConsumeInput {
      return { linkId, shopId, credentials: { linkId, secret: () => 'secret' } };
    },
  };
}

/** Crée un shopId fictif en base. */
async function createShopId(): Promise<string> {
  const user = await mongoose.connection.collection('users').insertOne({
    name: 'Boutique Test',
    phone: '70' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0'),
    countryCode: '226', password: 'hashed', role: 'user',
    slug: 'boutique-' + new mongoose.Types.ObjectId().toString(),
  });
  return user.insertedId.toString();
}

describe('CatalogConsumerService (lot 3, J7b)', () => {
  beforeAll(async () => {
    await connectDB();
    await Category.init();
    await Product.init();
    await SyncState.init();
  });

  // --- État de synchronisation -------------------------------------------------------

  describe('État de synchronisation', () => {
    it('crée l\'état IDLE (after=0, acknowledgedSeq=0) si absent', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service } = makeService([{ items: [], hasMore: false, lastSeq: 0 }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('IDLE');
      expect(state?.after).toBe(0);
      expect(state?.acknowledgedSeq).toBe(0);
    });

    it('bail actif → getCatalogChanges non appelé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE',
        leaseOwner: 'autre-instance', leaseUntil: new Date(Date.now() + 30_000),
      });
      await service.consume(input(shopId));
      expect(mockGetChanges).not.toHaveBeenCalled();
    });

    it('bail expiré → repris par un nouveau cycle', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([{ items: [], hasMore: false, lastSeq: 0 }]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE',
        leaseOwner: 'old-instance', leaseUntil: new Date(Date.now() - 1000),
      });
      await service.consume(input(shopId));
      expect(mockGetChanges).toHaveBeenCalled();
    });

    it('nextAttemptAt dans le futur → aucun appel GestStock', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE',
        nextAttemptAt: new Date(Date.now() + 10 * 60_000),
      });
      await service.consume(input(shopId));
      expect(mockGetChanges).not.toHaveBeenCalled();
    });
  });

  // --- CATEGORY -----------------------------------------------------------------------

  describe('Type CATEGORY', () => {
    it('UPSERT crée la catégorie avec external ref', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'CATEGORY', objectId: catId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: catId, name: 'Chaussures', description: 'Rayons', active: true, version: 1 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(cat?.name).toBe('Chaussures');
      expect(cat?.external?.source).toBe('geststock');
      expect(cat?.external?.version).toBe(1);
    });

    it('UPSERT version plus récente → met à jour le nom', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'Chaussures', normalizedName: 'chaussures',
        external: { source: 'geststock', id: catId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'CATEGORY', objectId: catId, version: 2,
          operation: 'UPSERT', occurredAt: '2026-01-02T12:00:00Z',
          data: { id: catId, name: 'Chaussures Sport', description: 'MAJ', active: true, version: 2 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(cat?.name).toBe('Chaussures Sport');
      expect(cat?.external?.version).toBe(2);
    });

    it('UPSERT version plus ancienne → n\'écrase pas', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'Bijoux Premium', normalizedName: 'bijoux premium',
        external: { source: 'geststock', id: catId, version: 5 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'CATEGORY', objectId: catId, version: 3,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: catId, name: 'Bijoux', description: '', active: true, version: 3 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(cat?.name).toBe('Bijoux Premium');
      expect(cat?.external?.version).toBe(5);
    });

    it('ARCHIVE → curseur avancé, catégorie non supprimée', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'Cat à archiver', normalizedName: 'cat a archiver',
        external: { source: 'geststock', id: catId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'CATEGORY', objectId: catId, version: 2,
          operation: 'ARCHIVE', occurredAt: '2026-01-01T12:00:00Z',
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      expect(await Category.findById(cat._id).lean()).not.toBeNull();
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.after).toBe(1);
    });
  });

  // --- PRODUCT ------------------------------------------------------------------------

  describe('Type PRODUCT', () => {
    it('UPSERT (création) : price = referencePrice, externalPrice = referencePrice', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'Cat', normalizedName: 'cat',
        external: { source: 'geststock', id: catId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: prodId, sku: 'P-001', name: 'Robe wax', description: 'Coton',
            categoryId: catId, unit: 'PIECE', referencePrice: '8500.00', active: true, version: 1 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.name).toBe('Robe wax');
      expect(prod?.price).toBe(8500);
      expect(prod?.externalPrice).toBe(8500);
      expect(prod?.external?.version).toBe(1);
    });

    it('UPSERT (mise à jour) : externalPrice mis à jour, price boutique inchangé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'Cat2', normalizedName: 'cat2',
        external: { source: 'geststock', id: catId, version: 1 } });
      await Product.create({ shopId, categoryId: cat._id, name: 'Produit', price: 15000, unit: 'PIECE',
        external: { source: 'geststock', id: prodId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 2,
          operation: 'UPSERT', occurredAt: '2026-01-02T12:00:00Z',
          data: { id: prodId, sku: 'P-001', name: 'Produit MAJ', description: '',
            categoryId: catId, unit: 'PIECE', referencePrice: '8000.00', active: true, version: 2 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.price).toBe(15000);       // prix boutique inchangé
      expect(prod?.externalPrice).toBe(8000); // prix de référence GestStock mis à jour
      expect(prod?.external?.version).toBe(2);
    });

    it('UPSERT version plus ancienne → n\'écrase pas', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'Cat3', normalizedName: 'cat3',
        external: { source: 'geststock', id: catId, version: 1 } });
      await Product.create({ shopId, categoryId: cat._id, name: 'Produit actuel', price: 9000, unit: 'PIECE',
        external: { source: 'geststock', id: prodId, version: 5 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 3,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: prodId, sku: 'P-001', name: 'Ancien nom', categoryId: catId,
            unit: 'PIECE', referencePrice: '5000.00', active: true, version: 3 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.name).toBe('Produit actuel');
      expect(prod?.external?.version).toBe(5);
    });

    it('UPSERT catégorie externe inconnue → BLOCKED/MISSING_CATEGORY, curseur arrêté', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: prodId, sku: 'X-001', name: 'Produit orphelin', categoryId: 'cat-inconnue-uuid',
            unit: 'PIECE', referencePrice: '1000.00', active: true, version: 1 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('BLOCKED');
      expect(state?.blockedReason).toBe('MISSING_CATEGORY');
      expect(state?.blockedEventSeq).toBe(1);
      expect(state?.after).toBe(0);  // curseur non avancé
      expect(await Product.findOne({ shopId, 'external.id': prodId }).lean()).toBeNull();
    });

    it('ARCHIVE → masque inStock=false, version-conditionné, produit non supprimé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'Cat4', normalizedName: 'cat4',
        external: { source: 'geststock', id: catId, version: 1 } });
      await Product.create({ shopId, categoryId: cat._id, name: 'Produit actif', price: 1000,
        unit: 'PIECE', inStock: true, external: { source: 'geststock', id: prodId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 2,
          operation: 'ARCHIVE', occurredAt: '2026-01-01T12:00:00Z',
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod).not.toBeNull();          // non supprimé
      expect(prod?.inStock).toBe(false);    // masqué
      expect(prod?.external?.version).toBe(2);
      expect((await SyncState.findOne({ linkId }).lean())?.after).toBe(1);
    });

    it('ARCHIVE version plus ancienne → n\'écrase pas (produit reste visible)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'Cat5', normalizedName: 'cat5',
        external: { source: 'geststock', id: catId, version: 1 } });
      await Product.create({ shopId, categoryId: cat._id, name: 'Produit', price: 1000,
        unit: 'PIECE', inStock: true, external: { source: 'geststock', id: prodId, version: 5 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 3,
          operation: 'ARCHIVE', occurredAt: '2026-01-01T12:00:00Z',
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.inStock).toBe(true);     // non masqué (version trop ancienne)
      expect(prod?.external?.version).toBe(5);
    });
  });

  // --- Ordonnancement -----------------------------------------------------------------

  describe('Ordonnancement', () => {
    it('même page : CATEGORY traitée avant PRODUCT (même si PRODUCT arrive en premier)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-' + new mongoose.Types.ObjectId().toString();
      const { service } = makeService([{
        items: [
          // PRODUCT arrive avant CATEGORY dans la liste
          { seq: 2, type: 'PRODUCT', objectId: prodId, version: 1,
            operation: 'UPSERT', occurredAt: '2026-01-01T12:00:01Z',
            data: { id: prodId, sku: 'ORD-001', name: 'Produit', description: '',
              categoryId: catId, unit: 'PIECE', referencePrice: '5000.00', active: true, version: 1 } },
          { seq: 1, type: 'CATEGORY', objectId: catId, version: 1,
            operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
            data: { id: catId, name: 'Cat Première', description: '', active: true, version: 1 } },
        ],
        hasMore: false, lastSeq: 2,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod).not.toBeNull();  // produit créé grâce à l'ordonnancement
    });
  });

  // --- Curseur et accusé de réception -------------------------------------------------

  describe('Curseur et accusé de réception', () => {
    it('curseur avancé à lastSeq après la page', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service } = makeService([{ items: [], hasMore: false, lastSeq: 77 }]);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.after).toBe(77);
    });

    it('hasMore=true → la page suivante est lue immédiatement', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([
        { items: [], hasMore: true, lastSeq: 10 },
        { items: [], hasMore: false, lastSeq: 20 },
      ]);
      await service.consume(input(shopId));
      expect(mockGetChanges).toHaveBeenCalledTimes(2);
      expect((await SyncState.findOne({ linkId }).lean())?.after).toBe(20);
    });

    it('accusé de réception envoyé avec le dernier curseur', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockAck } = makeService([{ items: [], hasMore: false, lastSeq: 50 }]);
      await service.consume(input(shopId));
      expect(mockAck).toHaveBeenCalledWith(expect.anything(), 50);
      expect((await SyncState.findOne({ linkId }).lean())?.acknowledgedSeq).toBe(50);
    });

    it('aucun accusé si curseur déjà à jour (acknowledgedSeq = after)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 50, acknowledgedSeq: 50, status: 'IDLE' });
      const { service, mockAck } = makeService([{ items: [], hasMore: false, lastSeq: 50 }]);
      await service.consume(input(shopId));
      expect(mockAck).not.toHaveBeenCalled();
    });
  });

  // --- Types non pris en charge -------------------------------------------------------

  describe('Types non pris en charge', () => {
    it('PRODUCT_IMAGE → curseur avancé, statut IDLE', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT_IMAGE', objectId: 'img-001', version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { imageId: 'img-001', productId: 'prod-001' },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.after).toBe(1);
      expect(state?.status).toBe('IDLE');
    });

    it('CHANNEL_PRICE → curseur avancé, statut IDLE', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'CHANNEL_PRICE', objectId: 'cp-001', version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { price: '1000.00' },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.after).toBe(1);
      expect(state?.status).toBe('IDLE');
    });

    it('type vraiment inconnu → BLOCKED/UNKNOWN_EVENT, curseur arrêté', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service } = makeService([{
        items: [{
          seq: 5, type: 'FUTURE_UNKNOWN_TYPE', objectId: 'some-uuid', version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { anything: true },
        }],
        hasMore: false, lastSeq: 5,
      }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('BLOCKED');
      expect(state?.blockedReason).toBe('UNKNOWN_EVENT');
      expect(state?.blockedEventSeq).toBe(5);
      expect(state?.after).toBe(0);  // curseur non avancé
    });
  });

  // --- Statuts terminaux → aucun appel GestStock -------------------------------------

  describe('Statuts terminaux', () => {
    for (const status of ['CURSOR_AHEAD', 'SNAPSHOT_REQUIRED', 'PAUSED'] as const) {
      it(`statut ${status} → aucun appel GestStock`, async () => {
        const shopId = await createShopId();
        const { linkId, input } = makeTest();
        const { service, mockGetChanges } = makeService([]);
        await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status });
        await service.consume(input(shopId));
        expect(mockGetChanges).not.toHaveBeenCalled();
      });
    }

    it('BLOCKED/UNKNOWN_EVENT → aucun appel GestStock', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0, status: 'BLOCKED', blockedReason: 'UNKNOWN_EVENT',
      });
      await service.consume(input(shopId));
      expect(mockGetChanges).not.toHaveBeenCalled();
    });

    it('BLOCKED/MISSING_CATEGORY → réessai au prochain cycle (appel GestStock effectué)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([{ items: [], hasMore: false, lastSeq: 0 }]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0, status: 'BLOCKED',
        blockedReason: 'MISSING_CATEGORY', blockedEventSeq: 1,
      });
      await service.consume(input(shopId));
      expect(mockGetChanges).toHaveBeenCalled();
    });
  });

  // --- Gestion des erreurs ------------------------------------------------------------

  describe('Gestion des erreurs', () => {
    it('409 CURSOR_AHEAD → statut CURSOR_AHEAD', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new GeststockError('CURSOR_AHEAD'); }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('CURSOR_AHEAD');
    });

    it('410 CURSOR_EXPIRED → statut SNAPSHOT_REQUIRED', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new GeststockError('CURSOR_EXPIRED'); }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('SNAPSHOT_REQUIRED');
    });

    it('LINK_REVOKED → révocation locale appelée, état sync supprimé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { GeststockError } = await import('@/lib/geststock-client');
      const mockRevoke = vi.fn(async () => null);
      const mockLinkRevoker: LinkRevoker = { revoke: mockRevoke };
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new GeststockError('LINK_REVOKED'); }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client, mockLinkRevoker);
      await service.consume(input(shopId));
      expect(mockRevoke).toHaveBeenCalledWith(shopId, linkId, null, expect.any(Date));
      expect(await SyncState.findOne({ linkId }).lean()).toBeNull();
    });

    it('403 LINK_SUSPENDED → statut PAUSED', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => {
          throw new GeststockError('REJECTED', { status: 403, code: 'LINK_SUSPENDED' });
        }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('PAUSED');
    });

    it('403 COMPANY_SUSPENDED → statut PAUSED', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => {
          throw new GeststockError('REJECTED', { status: 403, code: 'COMPANY_SUSPENDED' });
        }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('PAUSED');
    });

    it('429 RATE_LIMITED → nextAttemptAt défini selon Retry-After', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const before = Date.now();
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => {
          throw new GeststockError('RATE_LIMITED', { retryAfterSeconds: 60 });
        }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.nextAttemptAt).toBeInstanceOf(Date);
      expect(state?.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
      expect(state?.status).toBe('IDLE');
    });

    it('503 UNAVAILABLE → nextAttemptAt défini (backoff)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new GeststockError('UNAVAILABLE'); }),
        acknowledgeChanges: vi.fn(),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.nextAttemptAt).toBeInstanceOf(Date);
      expect(state?.status).toBe('IDLE');
    });
  });

  // --- Instantané complet (J8) -------------------------------------------------------

  describe('Instantané (lot 3, J8)', () => {
    it('statut SNAPSHOT_REQUIRED → appelle getSnapshot, pas getCatalogChanges', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service, mockGetSnapshot } = makeSnapshotService([
        { asOfSeq: 10, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null },
      ]);
      await service.consume(input(shopId));
      expect(mockGetSnapshot).toHaveBeenCalled();
    });

    it('crée la catégorie depuis l\'instantané', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-snap-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 5, currency: 'XOF',
        categories: [{ id: catId, name: 'Électronique', description: 'Appareils', active: true, version: 1 }],
        products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(cat?.name).toBe('Électronique');
      expect(cat?.external?.source).toBe('geststock');
    });

    it('crée le produit depuis l\'instantané (catégorie présente dans la page)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-snap-p-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-snap-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 8, currency: 'XOF',
        categories: [{ id: catId, name: 'Accessoires', description: '', active: true, version: 1 }],
        products: [{ id: prodId, name: 'Casque BT', description: '', categoryId: catId, referencePrice: '15000', unit: 'pièce', version: 1 }],
        productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.name).toBe('Casque BT');
      expect(prod?.externalPrice).toBe(15000);
      expect(prod?.external?.source).toBe('geststock');
    });

    it('instantané multi-page : catégories des deux pages présentes', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId1 = 'cat-p1-' + new mongoose.Types.ObjectId().toString();
      const catId2 = 'cat-p2-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const page1: SnapshotPage = {
        asOfSeq: 20, currency: 'XOF',
        categories: [{ id: catId1, name: 'Page1Cat', description: '', version: 1 }],
        products: [], productImages: [], nextPageToken: 'token-page-2',
      };
      const page2: SnapshotPage = {
        asOfSeq: 20, currency: 'XOF',
        categories: [{ id: catId2, name: 'Page2Cat', description: '', version: 1 }],
        products: [], productImages: [], nextPageToken: null,
      };
      const { service, mockGetSnapshot } = makeSnapshotService([page1, page2]);
      await service.consume(input(shopId));
      expect(mockGetSnapshot).toHaveBeenCalledTimes(2);
      expect(await Category.findOne({ shopId, 'external.id': catId1 }).lean()).not.toBeNull();
      expect(await Category.findOne({ shopId, 'external.id': catId2 }).lean()).not.toBeNull();
    });

    it('réconciliation : produit absent de l\'instantané → inStock=false', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-recon-' + new mongoose.Types.ObjectId().toString();
      const prodIdKept  = 'prod-kept-' + new mongoose.Types.ObjectId().toString();
      const prodIdGone  = 'prod-gone-' + new mongoose.Types.ObjectId().toString();
      await Category.create({
        shopId, name: 'CatRecon', normalizedName: 'catrecon',
        external: { source: 'geststock', id: catId, version: 1 },
      });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      await Product.create({
        shopId, name: 'Produit disparu', normalizedName: 'produit-disparu',
        categoryId: jcmbCat!._id, price: 5000, externalPrice: 5000, inStock: true,
        external: { source: 'geststock', id: prodIdGone, version: 1 },
      });
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 15, currency: 'XOF',
        categories: [{ id: catId, name: 'CatRecon', description: '', version: 1 }],
        products: [{ id: prodIdKept, name: 'Produit gardé', description: '', categoryId: catId, referencePrice: '3000', unit: 'pièce', version: 1 }],
        productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const gone = await Product.findOne({ shopId, 'external.id': prodIdGone }).lean();
      expect(gone?.inStock).toBe(false);
    });

    it('après instantané : statut IDLE, after=asOfSeq, accusé de réception envoyé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service, mockAck } = makeSnapshotService([{
        asOfSeq: 42, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('IDLE');
      expect(state?.after).toBe(42);
      expect(mockAck).toHaveBeenCalledWith(expect.anything(), 42);
    });

    it('SNAPSHOT_EXPIRED → statut reste SNAPSHOT_REQUIRED', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new Error('ne doit pas être appelé'); }),
        acknowledgeChanges: vi.fn(),
        getSnapshot: vi.fn(async () => { throw new GeststockError('SNAPSHOT_EXPIRED'); }),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('SNAPSHOT_REQUIRED');
    });

    it('503 UNAVAILABLE durant l\'instantané → SNAPSHOT_REQUIRED + nextAttemptAt', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new Error('ne doit pas être appelé'); }),
        acknowledgeChanges: vi.fn(),
        getSnapshot: vi.fn(async () => { throw new GeststockError('UNAVAILABLE'); }),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('SNAPSHOT_REQUIRED');
      expect(state?.nextAttemptAt).toBeInstanceOf(Date);
    });

    it('LINK_REVOKED durant l\'instantané → état sync supprimé, révocation locale', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { GeststockError } = await import('@/lib/geststock-client');
      const mockRevoke = vi.fn(async () => {});
      const linkRevoker: LinkRevoker = { revoke: mockRevoke };
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new Error('ne doit pas être appelé'); }),
        acknowledgeChanges: vi.fn(),
        getSnapshot: vi.fn(async () => { throw new GeststockError('LINK_REVOKED'); }),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client, linkRevoker);
      await service.consume(input(shopId));
      expect(mockRevoke).toHaveBeenCalledWith(shopId, linkId, null, expect.any(Date));
      expect(await SyncState.findOne({ linkId }).lean()).toBeNull();
    });

    it('LINK_SUSPENDED durant l\'instantané → statut PAUSED', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogChanges: vi.fn(async () => { throw new Error('ne doit pas être appelé'); }),
        acknowledgeChanges: vi.fn(),
        getSnapshot: vi.fn(async () => { throw new GeststockError('REJECTED', { status: 403, code: 'LINK_SUSPENDED' }); }),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consume(input(shopId));
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('PAUSED');
    });
  });
});
