import { beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import SyncState, { AppliedEvent } from '@/models/syncstate.model';
import { CatalogConsumerService, type ConsumeInput } from '@/services/catalog-consumer.service';
import type { CatalogChangePage, GeststockClient } from '@/lib/geststock-client';

/**
 * Consommateur du flux de catalogue GestStock (lot 3, J7) :
 * application des événements CATEGORY et PRODUCT, idempotence par registre
 * des seq appliqués, contrôle de version, remise à zéro sur CURSOR_AHEAD.
 */

const LINK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** Crée un service avec un client dont getCatalogChanges retourne les pages fournies. */
function makeService(pages: CatalogChangePage[]): {
  service: CatalogConsumerService;
  mockGetChanges: ReturnType<typeof vi.fn>;
} {
  let callCount = 0;
  const mockGetChanges = vi.fn(async () => {
    return pages[callCount++] ?? { items: [], hasMore: false, lastSeq: 0 };
  });
  const client = { getCatalogChanges: mockGetChanges } as unknown as GeststockClient;
  return { service: new CatalogConsumerService(client), mockGetChanges };
}

function input(shopId: string): ConsumeInput {
  return {
    linkId: LINK_ID,
    shopId,
    credentials: { linkId: LINK_ID, secret: () => 'secret' },
  };
}

/** Crée une boutique directement en base (sans passer par l'API). */
async function createShopId(): Promise<string> {
  const user = await mongoose.connection.collection('users').insertOne({
    name: 'Boutique Test',
    phone: '70' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0'),
    countryCode: '226',
    password: 'hashed',
    role: 'user',
    slug: 'boutique-test-' + new mongoose.Types.ObjectId().toString(),
  });
  return user.insertedId.toString();
}

describe('CatalogConsumerService (lot 3, J7)', () => {
  beforeAll(async () => {
    await connectDB();
    await Category.init();
    await Product.init();
    await SyncState.init();
    await AppliedEvent.init();
  });

  // --- Création de l'état de synchronisation -----------------------------------------

  it('crée l\'état IDLE (after=0) si absent', async () => {
    const shopId = await createShopId();
    const { service } = makeService([{ items: [], hasMore: false, lastSeq: 0 }]);
    await service.consume(input(shopId));
    const state = await SyncState.findOne({ linkId: LINK_ID }).lean();
    expect(state).not.toBeNull();
    expect(state?.status).toBe('IDLE');
    expect(state?.after).toBe(0);
  });

  // --- Événement CATEGORY UPSERT -------------------------------------------------------

  it('événement CATEGORY UPSERT crée la catégorie avec external ref', async () => {
    const shopId = await createShopId();
    const catId = 'cat-uuid-0001-0000-0000-000000000001';
    const { service } = makeService([
      {
        items: [{
          seq: 1, type: 'CATEGORY', objectId: catId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: catId, name: 'Chaussures', description: 'Rayons chaussures', active: true, version: 1 },
        }],
        hasMore: false,
        lastSeq: 1,
      },
    ]);

    await service.consume(input(shopId));

    const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
    expect(cat).not.toBeNull();
    expect(cat?.name).toBe('Chaussures');
    expect(cat?.external?.source).toBe('geststock');
    expect(cat?.external?.id).toBe(catId);
    expect(cat?.external?.version).toBe(1);
  });

  it('CATEGORY UPSERT version plus récente → met à jour le nom', async () => {
    const shopId = await createShopId();
    const catId = 'cat-uuid-0002-0000-0000-000000000001';

    // Première application : version 1
    const { service } = makeService([
      {
        items: [{
          seq: 1, type: 'CATEGORY', objectId: catId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: catId, name: 'Chaussures', description: '', active: true, version: 1 },
        }],
        hasMore: false, lastSeq: 1,
      },
      {
        items: [{
          seq: 2, type: 'CATEGORY', objectId: catId, version: 2,
          operation: 'UPSERT', occurredAt: '2026-01-02T12:00:00Z',
          data: { id: catId, name: 'Chaussures Sport', description: 'Mis à jour', active: true, version: 2 },
        }],
        hasMore: false, lastSeq: 2,
      },
    ]);

    await service.consume(input(shopId));
    // Resynchronise avec version 2
    await service.consume(input(shopId));

    const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
    expect(cat?.name).toBe('Chaussures Sport');
    expect(cat?.external?.version).toBe(2);
  });

  it('CATEGORY UPSERT version plus ancienne → n\'écrase pas', async () => {
    const shopId = await createShopId();
    const catId = 'cat-uuid-0003-0000-0000-000000000001';

    // Crée directement en base avec version 5
    await Category.create({
      shopId, name: 'Bijoux Premium', normalizedName: 'bijoux premium',
      external: { source: 'geststock', id: catId, version: 5 },
    });

    const { service } = makeService([
      {
        items: [{
          seq: 10, type: 'CATEGORY', objectId: catId, version: 3,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { id: catId, name: 'Bijoux', description: '', active: true, version: 3 },
        }],
        hasMore: false, lastSeq: 10,
      },
    ]);

    await service.consume(input(shopId));

    const cat = await Category.findOne({ shopId, 'external.id': catId }).lean();
    expect(cat?.name).toBe('Bijoux Premium');   // nom inchangé
    expect(cat?.external?.version).toBe(5);      // version inchangée
  });

  // --- Idempotence : registre des événements appliqués -----------------------------------

  it('rejouer le même événement (même seq) n\'applique pas deux fois', async () => {
    const shopId = await createShopId();
    const catId = 'cat-uuid-idem-0000-0000-000000000001';

    const page: CatalogChangePage = {
      items: [{
        seq: 5, type: 'CATEGORY', objectId: catId, version: 1,
        operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
        data: { id: catId, name: 'Montres', description: '', active: true, version: 1 },
      }],
      hasMore: false, lastSeq: 5,
    };

    const { service } = makeService([page, page]);

    await service.consume(input(shopId));
    await service.consume(input(shopId));   // rejoue depuis after=0 (simulé)

    const count = await Category.countDocuments({ shopId, 'external.id': catId });
    expect(count).toBe(1);   // pas de doublon
  });

  // --- Événement PRODUCT UPSERT --------------------------------------------------------

  it('événement PRODUCT UPSERT crée le produit lié à la catégorie externe', async () => {
    const shopId = await createShopId();
    const catId = 'cat-uuid-prod-0000-0000-000000000001';
    const prodId = 'prod-uuid-001-0000-0000-000000000001';

    // Crée la catégorie externe en base
    const cat = await Category.create({
      shopId, name: 'Robes', normalizedName: 'robes',
      external: { source: 'geststock', id: catId, version: 1 },
    });

    const { service } = makeService([
      {
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: {
            id: prodId, sku: 'ROB-001', name: 'Robe wax', description: 'Coton fin',
            categoryId: catId, unit: 'PIECE', referencePrice: '8500.00',
            active: true, version: 1,
          },
        }],
        hasMore: false, lastSeq: 1,
      },
    ]);

    await service.consume(input(shopId));

    const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
    expect(prod).not.toBeNull();
    expect(prod?.name).toBe('Robe wax');
    expect(prod?.price).toBe(8500);
    expect(prod?.categoryId.toString()).toBe(cat._id.toString());
    expect(prod?.external?.source).toBe('geststock');
    expect(prod?.external?.id).toBe(prodId);
    expect(prod?.external?.version).toBe(1);
  });

  it('PRODUCT UPSERT sans catégorie externe connue → produit ignoré', async () => {
    const shopId = await createShopId();
    const prodId = 'prod-uuid-nocat-000-0000-000000000001';
    const unknownCatId = 'cat-uuid-inco-0000-0000-000000000001';

    const { service } = makeService([
      {
        items: [{
          seq: 1, type: 'PRODUCT', objectId: prodId, version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: {
            id: prodId, sku: 'X-001', name: 'Produit orphelin', description: '',
            categoryId: unknownCatId, unit: 'PIECE', referencePrice: '1000.00',
            active: true, version: 1,
          },
        }],
        hasMore: false, lastSeq: 1,
      },
    ]);

    await service.consume(input(shopId));

    const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
    expect(prod).toBeNull();  // ignoré, catégorie introuvable
  });

  // --- Ordonnancement : CATEGORY avant PRODUCT dans la même page -----------------------

  it('même page : catégorie et produit créés dans le bon ordre (CATEGORY d\'abord)', async () => {
    const shopId = await createShopId();
    const catId = 'cat-uuid-order-000-0000-000000000001';
    const prodId = 'prod-uuid-order-000-0000-000000000001';

    const { service } = makeService([
      {
        items: [
          // Le produit arrive AVANT la catégorie dans la liste des événements
          {
            seq: 2, type: 'PRODUCT', objectId: prodId, version: 1,
            operation: 'UPSERT', occurredAt: '2026-01-01T12:00:01Z',
            data: {
              id: prodId, sku: 'ORD-001', name: 'Produit ordonné', description: '',
              categoryId: catId, unit: 'PIECE', referencePrice: '5000.00',
              active: true, version: 1,
            },
          },
          {
            seq: 1, type: 'CATEGORY', objectId: catId, version: 1,
            operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
            data: { id: catId, name: 'Catégorie Première', description: '', active: true, version: 1 },
          },
        ],
        hasMore: false, lastSeq: 2,
      },
    ]);

    await service.consume(input(shopId));

    const prod = await Product.findOne({ shopId, 'external.id': prodId }).lean();
    expect(prod).not.toBeNull();  // produit créé grâce au bon ordonnancement
  });

  // --- Avancement du curseur -----------------------------------------------------------

  it('curseur avancé à lastSeq après la page', async () => {
    const shopId = await createShopId();
    const { service } = makeService([
      { items: [], hasMore: false, lastSeq: 77 },
    ]);

    await service.consume(input(shopId));

    const state = await SyncState.findOne({ linkId: LINK_ID }).lean();
    expect(state?.after).toBe(77);
  });

  it('hasMore=true → la page suivante est lue immédiatement', async () => {
    const shopId = await createShopId();
    const { service, mockGetChanges } = makeService([
      { items: [], hasMore: true, lastSeq: 10 },
      { items: [], hasMore: false, lastSeq: 20 },
    ]);

    await service.consume(input(shopId));

    expect(mockGetChanges).toHaveBeenCalledTimes(2);
    const state = await SyncState.findOne({ linkId: LINK_ID }).lean();
    expect(state?.after).toBe(20);
  });

  // --- Type inconnu -------------------------------------------------------------------

  it('événement de type inconnu → ignoré, curseur avancé', async () => {
    const shopId = await createShopId();
    const { service } = makeService([
      {
        items: [{
          seq: 99, type: 'FUTURE_UNKNOWN_TYPE', objectId: 'some-uuid', version: 1,
          operation: 'UPSERT', occurredAt: '2026-01-01T12:00:00Z',
          data: { anything: true },
        }],
        hasMore: false, lastSeq: 99,
      },
    ]);

    await service.consume(input(shopId));

    const state = await SyncState.findOne({ linkId: LINK_ID }).lean();
    expect(state?.after).toBe(99);  // curseur avancé malgré type inconnu
  });

  // --- CURSOR_AHEAD -------------------------------------------------------------------

  it('409 CURSOR_AHEAD → status CURSOR_AHEAD, consommation stoppée', async () => {
    const shopId = await createShopId();
    const { GeststockError } = await import('@/lib/geststock-client');
    const mockGetChanges = vi.fn(async () => {
      throw new GeststockError('CURSOR_AHEAD');
    });
    const client = { getCatalogChanges: mockGetChanges } as unknown as GeststockClient;
    const service = new CatalogConsumerService(client);

    await service.consume(input(shopId));

    const state = await SyncState.findOne({ linkId: LINK_ID }).lean();
    expect(state?.status).toBe('CURSOR_AHEAD');
  });
});
