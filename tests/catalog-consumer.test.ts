import { beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import SyncState from '@/models/syncstate.model';
import GeststockLink from '@/models/geststock-link.model';
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

/** Crée une boutique fictive avec son slug (utile pour les tests de routes publiques). */
async function createShop(): Promise<{ shopId: string; slug: string }> {
  const slug = 'boutique-' + new mongoose.Types.ObjectId().toString();
  const user = await mongoose.connection.collection('users').insertOne({
    name: 'Boutique Test',
    phone: '70' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0'),
    countryCode: '226', password: 'hashed', role: 'user', slug,
  });
  return { shopId: user.insertedId.toString(), slug };
}

describe('CatalogConsumerService (lot 3, J7b)', () => {
  beforeAll(async () => {
    await connectDB();
    await Category.init();
    await Product.init();
    await SyncState.init();
    await GeststockLink.init();
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

    it('ARCHIVE sans produits GestStock → catégorie supprimée, curseur avancé', async () => {
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
      expect(await Category.findById(cat._id).lean()).toBeNull();
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

    it('ARCHIVE → visibleInShop=false, inStock conservé, version-conditionné, produit non supprimé', async () => {
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
      expect(prod).not.toBeNull();              // non supprimé
      expect(prod?.visibleInShop).toBe(false);  // masqué via visibleInShop
      expect(prod?.inStock).toBe(true);         // inStock non touché
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
      expect(prod?.visibleInShop).not.toBe(false); // non masqué (version trop ancienne)
      expect(prod?.inStock).toBe(true);
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
    // D5 : SNAPSHOT_REQUIRED n'est pas terminal — il déclenche consumeSnapshot (testé dans le describe J8).
    for (const status of ['CURSOR_AHEAD', 'PAUSED'] as const) {
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

    it('BLOCKED/MISSING_CATEGORY sans autoSnapshot → déclenche consumeSnapshot (D7)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges, mockGetSnapshot } = (() => {
        const { service: s, mockGetChanges: mgc } = makeService([]);
        const mockGetSnapshot = vi.fn(async () => ({ asOfSeq: 0, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null }));
        // On utilise makeSnapshotService car makeService mock aussi getSnapshot — on vérifie juste que getCatalogChanges n'est PAS appelé
        return { service: s, mockGetChanges: mgc, mockGetSnapshot };
      })();
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0, status: 'BLOCKED',
        blockedReason: 'MISSING_CATEGORY', blockedEventSeq: 1, blockedAutoSnapshotDone: false,
      });
      await service.consume(input(shopId));
      // D7 : consumeSnapshot est appelé, getCatalogChanges ne l'est pas
      expect(mockGetChanges).not.toHaveBeenCalled();
      // État final : IDLE (l'instantané a réussi grâce au mock de makeService)
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('IDLE');
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
      expect(gone?.visibleInShop).toBe(false);  // masqué via visibleInShop (D6)
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

    // D1 : réconciliation sans garde
    it('D1 — instantané avec products:[] → produits GestStock locaux masqués (visibleInShop=false)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-d1-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'Cat', normalizedName: 'cat',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      // Produit GestStock existant, non repris dans l'instantané
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Orphelin', price: 500,
        inStock: true, visibleInShop: true,
        external: { source: 'geststock', id: 'prod-orphelin', version: 1 } });
      // Produit boutique pure (pas de source geststock) → jamais touché
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Boutique', price: 500 });
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 10, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const orphelin = await Product.findOne({ shopId, 'external.id': 'prod-orphelin' }).lean();
      expect(orphelin?.visibleInShop).toBe(false);  // masqué
      expect(orphelin?.inStock).toBe(true);          // inStock conservé
      // Produit boutique pure : visibleInShop toujours true
      const boutique = await Product.findOne({ shopId, name: 'Boutique' }).lean();
      expect(boutique?.visibleInShop).not.toBe(false);
    });

    // D3 : blockedReason effacé pendant et après l'instantané
    it('D3 — blockedReason et blockedEventSeq effacés après instantané réussi', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      // Partir d'un état BLOCKED/MISSING_CATEGORY avec blockedEventSeq posé
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0,
        status: 'SNAPSHOT_REQUIRED',
        blockedReason: 'MISSING_CATEGORY', blockedEventSeq: 7,
      });
      const { service } = makeSnapshotService([{
        asOfSeq: 20, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('IDLE');
      expect(state?.blockedReason).toBeNull();
      expect(state?.blockedEventSeq).toBeNull();
    });
  });

  // --- Devise (lot 3, J8b, D4) ---------------------------------------------------------

  describe('Devise (lot 3, J8b, D4)', () => {
    it('devise différente de expectedCurrency → BLOCKED/CURRENCY_MISMATCH, curseur inchangé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 10, currency: 'EUR',   // ≠ 'XOF' attendu
        categories: [], products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume({ ...input(shopId), expectedCurrency: 'XOF' });
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('BLOCKED');
      expect(state?.blockedReason).toBe('CURRENCY_MISMATCH');
      expect(state?.after).toBe(0);  // curseur inchangé
    });

    it('devise incohérente entre pages → BLOCKED/CURRENCY_MISMATCH sur la deuxième page', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-dev-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([
        { asOfSeq: 20, currency: 'XOF', categories: [{ id: catId, name: 'Cat', description: '', version: 1 }], products: [], productImages: [], nextPageToken: 'tok2' },
        { asOfSeq: 20, currency: 'EUR', categories: [], products: [], productImages: [], nextPageToken: null },
      ]);
      await service.consume({ ...input(shopId), expectedCurrency: 'XOF' });
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('BLOCKED');
      expect(state?.blockedReason).toBe('CURRENCY_MISMATCH');
      expect(state?.after).toBe(0);    // curseur inchangé
      // Catégorie de la page 1 créée (page 1 était correcte)
      expect(await Category.findOne({ shopId, 'external.id': catId }).lean()).not.toBeNull();
    });

    it('BLOCKED/CURRENCY_MISMATCH → aucun appel GestStock au cycle suivant', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([]);
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'BLOCKED', blockedReason: 'CURRENCY_MISMATCH' });
      await service.consume(input(shopId));
      expect(mockGetChanges).not.toHaveBeenCalled();
    });

    it('devise correcte sur toutes les pages → instantané complète normalement', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 15, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume({ ...input(shopId), expectedCurrency: 'XOF' });
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('IDLE');
    });
  });

  // --- Sortie de BLOCKED/MISSING_CATEGORY (lot 3, J8b, D7) ----------------------------

  describe('Sortie de BLOCKED/MISSING_CATEGORY (lot 3, J8b, D7)', () => {
    it('BLOCKED/MISSING_CATEGORY sans autoSnapshot → déclenche consumeSnapshot, récupère IDLE', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-d7-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({
        linkId, after: 5, acknowledgedSeq: 5,
        status: 'BLOCKED', blockedReason: 'MISSING_CATEGORY', blockedEventSeq: 6,
        blockedAutoSnapshotDone: false,
      });
      const { service, mockGetSnapshot } = makeSnapshotService([{
        asOfSeq: 10, currency: 'XOF',
        categories: [{ id: catId, name: 'CatD7', description: '', version: 1 }],
        products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      expect(mockGetSnapshot).toHaveBeenCalled();
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.status).toBe('IDLE');
      expect(state?.after).toBe(10);
      expect(state?.blockedAutoSnapshotDone).toBeNull();  // effacé après IDLE
    });

    it('BLOCKED/MISSING_CATEGORY avec autoSnapshot=true → reste BLOCKED, aucun appel GestStock', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetSnapshot } = makeSnapshotService([]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0,
        status: 'BLOCKED', blockedReason: 'MISSING_CATEGORY', blockedEventSeq: 1,
        blockedAutoSnapshotDone: true,
      });
      await service.consume(input(shopId));
      expect(mockGetSnapshot).not.toHaveBeenCalled();
      expect((await SyncState.findOne({ linkId }).lean())?.status).toBe('BLOCKED');
    });

    it('BLOCKED/UNKNOWN_EVENT → aucun appel GestStock', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const { service, mockGetChanges } = makeService([]);
      await SyncState.create({
        linkId, after: 0, acknowledgedSeq: 0,
        status: 'BLOCKED', blockedReason: 'UNKNOWN_EVENT', blockedEventSeq: 3,
      });
      await service.consume(input(shopId));
      expect(mockGetChanges).not.toHaveBeenCalled();
    });
  });

  // --- Visibilité GestStock (lot 3, J8b, D6) ------------------------------------------

  describe('Visibilité GestStock (lot 3, J8b, D6)', () => {
    it('UPSERT plus récent sur produit archivé → visibleInShop=true (rétablissement)', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-vis-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-vis-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'CatVis', normalizedName: 'catvis',
        external: { source: 'geststock', id: catId, version: 1 } });
      // Produit archivé (visibleInShop=false)
      await Product.create({ shopId, categoryId: cat._id, name: 'Archivé', price: 1000,
        visibleInShop: false, external: { source: 'geststock', id: prodId, version: 2 } });
      const { service } = makeService([{
        items: [{
          seq: 3, type: 'PRODUCT', objectId: prodId, version: 3,
          operation: 'UPSERT', occurredAt: '2026-01-03T12:00:00Z',
          data: { id: prodId, name: 'Rétabli', description: '', categoryId: catId, unit: 'pièce', referencePrice: '2000.00', active: true, version: 3 },
        }],
        hasMore: false, lastSeq: 3,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.visibleInShop).toBe(true);
      expect(prod?.name).toBe('Rétabli');
    });

    it('inStock=true posé manuellement sur un produit archivé → visibleInShop reste false', async () => {
      const shopId = await createShopId();
      const catId = 'cat-instock-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-instock-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'CatIS', normalizedName: 'catis',
        external: { source: 'geststock', id: catId, version: 1 } });
      await Product.create({ shopId, categoryId: cat._id, name: 'Archivé', price: 500,
        visibleInShop: false, inStock: false,
        external: { source: 'geststock', id: prodId, version: 1 } });
      // Le commerçant remet inStock=true manuellement
      await Product.updateOne({ shopId, 'external.id': prodId }, { $set: { inStock: true } });
      // visibleInShop doit rester false
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.inStock).toBe(true);
      expect(prod?.visibleInShop).toBe(false);
    });

    it('produit sans external.source=geststock → jamais touché par la réconciliation', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-pure-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatPure', normalizedName: 'catpure',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      // Produit boutique pure (pas d'external)
      const pureProd = await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'ProdPur', price: 1000, visibleInShop: true });
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 5, currency: 'XOF', categories: [], products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const after = await Product.findById(pureProd._id).lean();
      expect(after?.visibleInShop).not.toBe(false);
    });

    it('route GET /api/public/shop/[slug] → n\'affiche pas un produit masqué (visibleInShop=false)', async () => {
      const { shopId, slug } = await createShop();
      const catId = new mongoose.Types.ObjectId();
      // Produit visible
      await Product.create({ shopId, categoryId: catId, name: 'Visible', price: 1000, visibleInShop: true });
      // Produit masqué
      await Product.create({ shopId, categoryId: catId, name: 'Masqué', price: 500, visibleInShop: false });
      const { GET } = await import('@/app/api/public/shop/[slug]/route');
      const req = new Request(`http://localhost/api/public/shop/${slug}`);
      const resp = await GET(req, { params: Promise.resolve({ slug }) });
      const json = await resp.json() as { data: { products: Array<{ name: string }> } };
      const names = json.data.products.map((p) => p.name);
      expect(names).toContain('Visible');
      expect(names).not.toContain('Masqué');
    });

    it('route GET /api/public/shop/[slug]/products/[id] → 404 si produit masqué', async () => {
      const { shopId, slug } = await createShop();
      const catId = new mongoose.Types.ObjectId();
      const hidden = await Product.create({ shopId, categoryId: catId, name: 'Caché', price: 500, visibleInShop: false });
      const { GET } = await import('@/app/api/public/shop/[slug]/products/[id]/route');
      const req = new Request(`http://localhost/api/public/shop/${slug}/products/${hidden._id}`);
      const resp = await GET(req, { params: Promise.resolve({ slug, id: hidden._id.toString() }) });
      expect(resp.status).toBe(404);
    });
  });

  // --- Images par empreinte (J9) -------------------------------------------------------

  describe('Images par empreinte (lot 3, J9)', () => {
    /** Client minimal pour consumeImages */
    function makeImageClient(result: import('@/lib/geststock-client').ProductImageResult) {
      return {
        getCatalogChanges:    vi.fn(async () => { throw new Error('ne doit pas être appelé'); }),
        acknowledgeChanges:   vi.fn(),
        getSnapshot:          vi.fn(async () => { throw new Error('ne doit pas être appelé'); }),
        getCatalogProductImage: vi.fn(async () => result),
      } as unknown as GeststockClient;
    }

    it('événement PRODUCT_IMAGE UPSERT → imageSha256 et imageVersion enregistrés sur le produit', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-img-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-img-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatImg', normalizedName: 'catimg',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Produit', price: 1000,
        external: { source: 'geststock', id: prodId, version: 1 } });
      const sha = 'a'.repeat(64);
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT_IMAGE', objectId: prodId, version: 2,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { productId: prodId, imageSha256: sha, version: 2 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageSha256).toBe(sha);
      expect(prod?.imageVersion).toBe(2);
    });

    it('événement PRODUCT_IMAGE version plus ancienne → empreinte non écrasée', async () => {
      const shopId = await createShopId();
      const { input } = makeTest();
      const catId  = 'cat-img2-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-img2-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatImg2', normalizedName: 'catimg2',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      const shaOld = 'b'.repeat(64);
      const shaNew = 'c'.repeat(64);
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Produit', price: 1000,
        imageSha256: shaNew, imageVersion: 5,
        external: { source: 'geststock', id: prodId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT_IMAGE', objectId: prodId, version: 3,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { productId: prodId, imageSha256: shaOld, version: 3 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageSha256).toBe(shaNew);
      expect(prod?.imageVersion).toBe(5);
    });

    it('événement PRODUCT_IMAGE UPSERT imageSha256=null → retrait d\'image', async () => {
      const shopId = await createShopId();
      const { input } = makeTest();
      const catId  = 'cat-img3-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-img3-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatImg3', normalizedName: 'catimg3',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Produit', price: 1000,
        imageSha256: 'd'.repeat(64), imageVersion: 1, imageETag: 'd'.repeat(64),
        external: { source: 'geststock', id: prodId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 1, type: 'PRODUCT_IMAGE', objectId: prodId, version: 2,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { productId: prodId, imageSha256: null, version: 2 },
        }],
        hasMore: false, lastSeq: 1,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageSha256).toBeNull();
    });

    it('instantané : productImages → imageSha256 et imageVersion enregistrés', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-snap-img-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-snap-img-' + new mongoose.Types.ObjectId().toString();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const sha = 'e'.repeat(64);
      const { service } = makeSnapshotService([{
        asOfSeq: 10, currency: 'XOF',
        categories: [{ id: catId, name: 'CatSnapImg', description: '', version: 1 }],
        products: [{ id: prodId, name: 'Prod', description: '', categoryId: catId, referencePrice: '1000', unit: 'pièce', version: 1 }],
        productImages: [{ productId: prodId, imageSha256: sha, version: 1 }],
        nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageSha256).toBe(sha);
      expect(prod?.imageVersion).toBe(1);
    });

    it('consumeImages : empreinte nouvelle → getCatalogProductImage appelé, imageETag enregistré', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-dl-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-dl-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatDl', normalizedName: 'catdl',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      const sha = 'f'.repeat(64);
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Prod', price: 1000,
        imageSha256: sha, imageVersion: 1,
        external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 10, acknowledgedSeq: 10, status: 'IDLE' });
      const mockFetch = vi.fn(async () => ({ kind: 'image' as const, data: Buffer.from('jpeg'), etag: sha }));
      const client = makeImageClient({ kind: 'image', data: Buffer.from('jpeg'), etag: sha });
      (client as unknown as { getCatalogProductImage: typeof mockFetch }).getCatalogProductImage = mockFetch;
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      expect(mockFetch).toHaveBeenCalledWith(expect.anything(), prodId, null);
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageETag).toBe(sha);
    });

    it('consumeImages : ETag identique à imageSha256 → aucun appel GestStock', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-cached-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-cached-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatCached', normalizedName: 'catcached',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      const sha = '0'.repeat(64);
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Prod', price: 1000,
        imageSha256: sha, imageVersion: 1, imageETag: sha,
        external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 10, acknowledgedSeq: 10, status: 'IDLE' });
      const mockFetch = vi.fn();
      const client = { getCatalogProductImage: mockFetch } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('consumeImages : 304 not_modified → imageETag inchangé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-304-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-304-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'Cat304', normalizedName: 'cat304',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      const sha = '1'.repeat(64);
      const oldEtag = '2'.repeat(64);
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Prod', price: 1000,
        imageSha256: sha, imageVersion: 2, imageETag: oldEtag,
        external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 10, acknowledgedSeq: 10, status: 'IDLE' });
      const client = makeImageClient({ kind: 'not_modified' });
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageETag).toBe(oldEtag);
    });

    it('consumeImages : 404 not_found → imageSha256 et imageETag effacés', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-nf-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-nf-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatNf', normalizedName: 'catnf',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      const sha = '3'.repeat(64);
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Prod', price: 1000,
        imageSha256: sha, imageVersion: 1,
        external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 10, acknowledgedSeq: 10, status: 'IDLE' });
      const client = makeImageClient({ kind: 'not_found' });
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      expect(prod?.imageSha256).toBeNull();
      expect(prod?.imageETag).toBeNull();
    });

    it('consumeImages : 429 → imageNextAttemptAt posé, arrêt immédiat', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-429-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-429-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'Cat429', normalizedName: 'cat429',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Prod', price: 1000,
        imageSha256: '4'.repeat(64), imageVersion: 1,
        external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 10, acknowledgedSeq: 10, status: 'IDLE' });
      const { GeststockError } = await import('@/lib/geststock-client');
      const client = {
        getCatalogProductImage: vi.fn(async () => { throw new GeststockError('RATE_LIMITED', { retryAfterSeconds: 60 }); }),
      } as unknown as GeststockClient;
      const before = Date.now();
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      const state = await SyncState.findOne({ linkId }).lean();
      expect(state?.imageNextAttemptAt).toBeInstanceOf(Date);
      expect(state?.imageNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    });

    it('consumeImages : backoff actif → aucun appel GestStock', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'IDLE',
        imageNextAttemptAt: new Date(Date.now() + 10 * 60_000) });
      const mockFetch = vi.fn();
      const client = { getCatalogProductImage: mockFetch } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // --- ETag faible (lot 3, B5-D1) ------------------------------------------------

  describe('ETag faible (lot 3, B5-D1)', () => {
    it('consumeImages : etag=null (ETag faible rejeté par le client) → imageETag existant conservé, non écrasé', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-wetag-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-wetag-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatWEtag', normalizedName: 'catwetag',
        external: { source: 'geststock', id: catId, version: 1 } });
      const jcmbCat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      const sha = 'd'.repeat(64);
      const oldEtag = 'e'.repeat(64);
      await Product.create({ shopId, categoryId: jcmbCat!._id, name: 'Prod', price: 1000,
        imageSha256: sha, imageVersion: 1, imageETag: oldEtag,
        external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 10, acknowledgedSeq: 10, status: 'IDLE' });
      // Le client retourne etag: null (ETag faible rejeté par la couche client)
      const client = {
        getCatalogChanges:    vi.fn(),
        acknowledgeChanges:   vi.fn(),
        getSnapshot:          vi.fn(),
        getCatalogProductImage: vi.fn(async () => ({ kind: 'image' as const, data: Buffer.from('jpeg'), etag: null })),
      } as unknown as GeststockClient;
      const service = new CatalogConsumerService(client);
      await service.consumeImages(input(shopId));
      const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
      // imageETag doit rester à l'ancienne valeur (non écrasée par null)
      expect(prod?.imageETag).toBe(oldEtag);
    });
  });

  // --- ARCHIVE CATEGORY (lot 3, J10) ---------------------------------------------

  describe('ARCHIVE CATEGORY (lot 3, J10)', () => {
    it('ARCHIVE CATEGORY sans produits GestStock visibles → catégorie supprimée', async () => {
      const shopId = await createShopId();
      const { input } = makeTest();
      const catId = 'cat-arc-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatArc', normalizedName: 'catarc',
        external: { source: 'geststock', id: catId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 5, type: 'CATEGORY', objectId: catId, version: 2,
          operation: 'ARCHIVE', occurredAt: '2026-01-05T12:00:00Z', data: null as unknown as Record<string, unknown>,
        }],
        hasMore: false, lastSeq: 5,
      }]);
      await service.consume(input(shopId));
      const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(cat).toBeNull();
    });

    it('ARCHIVE CATEGORY avec produits GestStock visibles → catégorie conservée', async () => {
      const shopId = await createShopId();
      const { input } = makeTest();
      const catId = 'cat-arc2-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'CatArc2', normalizedName: 'catarc2',
        external: { source: 'geststock', id: catId, version: 1 } });
      const prodId = 'prod-arc2-' + new mongoose.Types.ObjectId().toString();
      await Product.create({ shopId, categoryId: cat._id, name: 'Prod', price: 1000,
        visibleInShop: true, external: { source: 'geststock', id: prodId, version: 1 } });
      const { service } = makeService([{
        items: [{
          seq: 6, type: 'CATEGORY', objectId: catId, version: 2,
          operation: 'ARCHIVE', occurredAt: '2026-01-06T12:00:00Z', data: null as unknown as Record<string, unknown>,
        }],
        hasMore: false, lastSeq: 6,
      }]);
      await service.consume(input(shopId));
      const catAfter = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(catAfter).not.toBeNull();
    });
  });

  // --- Réconciliation des catégories (lot 3, J10) ---------------------------------

  describe('Réconciliation des catégories (lot 3, J10)', () => {
    it('instantané contenant la catégorie → aucune suppression', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId = 'cat-rec-' + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatRec', normalizedName: 'catrec',
        external: { source: 'geststock', id: catId, version: 1 } });
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 10, currency: 'XOF',
        categories: [{ id: catId, name: 'CatRec', description: '', version: 2 }],
        products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(cat).not.toBeNull();
    });

    it('catégorie GestStock absente du snapshot, sans produits visibles → supprimée', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catPresent = 'cat-present-' + new mongoose.Types.ObjectId().toString();
      const catGone    = 'cat-gone-'    + new mongoose.Types.ObjectId().toString();
      await Category.create({ shopId, name: 'CatPresente', normalizedName: 'catpresente',
        external: { source: 'geststock', id: catPresent, version: 1 } });
      await Category.create({ shopId, name: 'CatGone', normalizedName: 'catgone',
        external: { source: 'geststock', id: catGone, version: 1 } });
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      const { service } = makeSnapshotService([{
        asOfSeq: 10, currency: 'XOF',
        categories: [{ id: catPresent, name: 'CatPresente', description: '', version: 1 }],
        products: [], productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      expect(await Category.findOne({ shopId, 'external.id': catGone }).lean()).toBeNull();
      expect(await Category.findOne({ shopId, 'external.id': catPresent }).lean()).not.toBeNull();
    });

    it('catégorie GestStock absente du snapshot, avec produits GestStock visibles → conservée', async () => {
      const shopId = await createShopId();
      const { linkId, input } = makeTest();
      const catId  = 'cat-keep-' + new mongoose.Types.ObjectId().toString();
      const prodId = 'prod-keep-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'CatKeep', normalizedName: 'catkeep',
        external: { source: 'geststock', id: catId, version: 1 } });
      await Product.create({ shopId, categoryId: cat._id, name: 'Prod', price: 1000,
        visibleInShop: true, external: { source: 'geststock', id: prodId, version: 1 } });
      await SyncState.create({ linkId, after: 0, acknowledgedSeq: 0, status: 'SNAPSHOT_REQUIRED' });
      // Le produit est inclus dans le snapshot (seenProductIds) pour ne pas être masqué
      // par la réconciliation des produits avant la réconciliation des catégories.
      // La catégorie n'est PAS dans le snapshot → orpheline mais conservée (a des produits visibles).
      const { service } = makeSnapshotService([{
        asOfSeq: 10, currency: 'XOF',
        categories: [],
        products: [{ id: prodId, name: 'Prod', categoryId: catId, description: '', unit: 'pièce', referencePrice: '1000.00', active: true, version: 1 }],
        productImages: [], nextPageToken: null,
      }]);
      await service.consume(input(shopId));
      const catAfter = await Category.findOne({ shopId, 'external.id': catId }).lean();
      expect(catAfter).not.toBeNull();
    });
  });
});
