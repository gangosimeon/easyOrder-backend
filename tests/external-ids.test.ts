import { beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import { POST as createCategory } from '@/app/api/categories/route';
import { PUT as updateCategory } from '@/app/api/categories/[id]/route';
import { POST as createProduct, GET as listProducts } from '@/app/api/products/route';
import { GET as getProduct, PUT as updateProduct } from '@/app/api/products/[id]/route';
import { createShop, jsonRequest } from './helpers';

/**
 * Identifiants externes des produits et catégories (lot 3, J6) :
 * sous-document { source, id, version } réservé à la synchronisation GestStock,
 * en lecture seule pour l'API boutique ; index unique partiel par boutique.
 */
describe('Identifiants externes J6', () => {
  beforeAll(async () => {
    await connectDB();
    await Product.init();
    await Category.init();
  });

  // --- Champ absent par défaut -----------------------------------------------------------

  it('un produit créé normalement ne porte pas de champ external', async () => {
    const shop = await createShop('Boutique Sans External', '70100001');
    const catRes = await (await createCategory(jsonRequest('/api/categories', { name: 'Chaussures' }, { token: shop.token }))).json();
    const prodRes = await (await createProduct(jsonRequest('/api/products', {
      categoryId: catRes.data._id, name: 'Derby', price: 15000,
    }, { token: shop.token }))).json();
    expect(prodRes.data.external).toBeUndefined();
  });

  // --- Lecture seule via l'API boutique --------------------------------------------------

  it('POST /api/products avec external → 400', async () => {
    const shop = await createShop('Boutique Prod POST', '70100002');
    const catRes = await (await createCategory(jsonRequest('/api/categories', { name: 'Robes' }, { token: shop.token }))).json();
    const res = await createProduct(jsonRequest('/api/products', {
      categoryId: catRes.data._id, name: 'Robe wax', price: 12000,
      external: { source: 'geststock', id: 'some-uuid', version: 1 },
    }, { token: shop.token }));
    expect(res.status).toBe(400);
  });

  it('PUT /api/products/:id avec external → 400', async () => {
    const shop = await createShop('Boutique Prod PUT', '70100003');
    const catRes = await (await createCategory(jsonRequest('/api/categories', { name: 'Sacs' }, { token: shop.token }))).json();
    const prodRes = await (await createProduct(jsonRequest('/api/products', {
      categoryId: catRes.data._id, name: 'Sac cuir', price: 8000,
    }, { token: shop.token }))).json();
    const id = prodRes.data._id as string;
    const res = await updateProduct(
      jsonRequest(`/api/products/${id}`, { external: { source: 'geststock', id: 'x', version: 2 } }, { token: shop.token, method: 'PUT' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/categories avec external → 400', async () => {
    const shop = await createShop('Boutique Cat POST', '70100004');
    const res = await createCategory(jsonRequest('/api/categories', {
      name: 'Accessoires',
      external: { source: 'geststock', id: 'cat-uuid', version: 1 },
    }, { token: shop.token }));
    expect(res.status).toBe(400);
  });

  it('PUT /api/categories/:id avec external → 400', async () => {
    const shop = await createShop('Boutique Cat PUT', '70100005');
    const catRes = await (await createCategory(jsonRequest('/api/categories', { name: 'Bijoux' }, { token: shop.token }))).json();
    const id = catRes.data._id as string;
    const res = await updateCategory(
      jsonRequest(`/api/categories/${id}`, { external: { source: 'geststock', id: 'cat-uuid', version: 1 } }, { token: shop.token, method: 'PUT' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  // --- Index unique partiel --------------------------------------------------------------

  it('deux produits de même boutique avec le même external.source + external.id → erreur', async () => {
    const shopId = new mongoose.Types.ObjectId();
    const catId  = new mongoose.Types.ObjectId();
    const ext = { source: 'geststock', id: 'gs-prod-001', version: 1 };
    await Product.create({ shopId, categoryId: catId, price: 1000, external: ext });
    await expect(
      Product.create({ shopId, categoryId: catId, price: 2000, external: ext })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('deux boutiques différentes peuvent avoir le même external.source + external.id', async () => {
    const catId = new mongoose.Types.ObjectId();
    const ext   = { source: 'geststock', id: 'gs-prod-shared', version: 1 };
    await Product.create({ shopId: new mongoose.Types.ObjectId(), categoryId: catId, price: 1000, external: ext });
    await Product.create({ shopId: new mongoose.Types.ObjectId(), categoryId: catId, price: 2000, external: ext });
    // aucune erreur attendue
  });

  // --- Visible via l'API après écriture par le service de synchronisation ----------------

  it('external écrit directement en base (service sync) est visible via GET', async () => {
    const shop = await createShop('Boutique Sync Visible', '70100006');
    const catRes = await (await createCategory(jsonRequest('/api/categories', { name: 'Montres' }, { token: shop.token }))).json();
    const prodRes = await (await createProduct(jsonRequest('/api/products', {
      categoryId: catRes.data._id, name: 'Montre Casio', price: 5000,
    }, { token: shop.token }))).json();
    const id = prodRes.data._id as string;

    // Le service de synchronisation écrit external directement (hors API boutique).
    await Product.updateOne({ _id: id }, { $set: { external: { source: 'geststock', id: 'gs-watch-001', version: 3 } } });

    const getRes = await (await getProduct(
      jsonRequest(`/api/products/${id}`, undefined, { token: shop.token }),
      { params: Promise.resolve({ id }) },
    )).json();
    expect(getRes.data.external).toMatchObject({ source: 'geststock', id: 'gs-watch-001', version: 3 });
  });

  // --- Index partiel vérifié structurellement -------------------------------------------

  it('index unique partiel sur external.source/external.id présent sur les produits', async () => {
    const indexes = await mongoose.connection.collection('products').indexes();
    const idx = indexes.find(
      (i) => i.key?.['external.source'] === 1 && i.key?.['external.id'] === 1
    );
    expect(idx?.unique).toBe(true);
    expect(idx?.partialFilterExpression).toEqual({ 'external.source': { $exists: true } });
  });

  it('index unique partiel sur external.source/external.id présent sur les catégories', async () => {
    const indexes = await mongoose.connection.collection('categories').indexes();
    const idx = indexes.find(
      (i) => i.key?.['external.source'] === 1 && i.key?.['external.id'] === 1
    );
    expect(idx?.unique).toBe(true);
    expect(idx?.partialFilterExpression).toEqual({ 'external.source': { $exists: true } });
  });
});
