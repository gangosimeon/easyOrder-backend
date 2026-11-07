import { beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import User from '@/models/user.model';
import { GET as getPriceSuggestions } from '@/app/api/products/price-suggestions/route';
import { POST as acceptExternalPrice } from '@/app/api/products/[id]/accept-external-price/route';
import { createShop, jsonRequest } from './helpers';

/**
 * Routes de suggestions de prix GestStock (lot 3, J11.2) :
 * GET  /api/products/price-suggestions
 * POST /api/products/[id]/accept-external-price
 */

let phoneCounter = 0;
function phone(): string {
  phoneCounter += 1;
  return `78${String(phoneCounter).padStart(6, '0')}`;
}

describe('Suggestions de prix GestStock (lot 3, J11.2)', () => {
  beforeAll(async () => {
    await connectDB();
    await Category.init();
    await Product.init();
  });

  async function shop() {
    const s = await createShop('Boutique Prix', phone());
    await User.updateOne({ _id: s.id }, { isActive: true });
    return s;
  }

  async function setupProducts(shopId: string) {
    const shopOid = new mongoose.Types.ObjectId(shopId);
    const cat = await Category.create({ shopId: shopOid, name: 'Cat', normalizedName: 'cat', icon: 'i', color: '#f' });

    const [prodDiff, prodSame, prodLocal] = await Product.create([
      // prix diffère → doit apparaître dans les suggestions
      { shopId: shopOid, categoryId: cat._id, name: 'Produit GS diff', price: 3000, image: '', description: '', unit: '', stock: 1, inStock: true,
        external: { source: 'geststock', id: 'gs-1', version: 1 }, externalPrice: 3500 },
      // prix identique → ne doit PAS apparaître
      { shopId: shopOid, categoryId: cat._id, name: 'Produit GS same', price: 2000, image: '', description: '', unit: '', stock: 1, inStock: true,
        external: { source: 'geststock', id: 'gs-2', version: 1 }, externalPrice: 2000 },
      // produit local (sans external) → ne doit PAS apparaître
      { shopId: shopOid, categoryId: cat._id, name: 'Produit Local', price: 1000, image: '', description: '', unit: '', stock: 1, inStock: true },
    ]);
    return { prodDiff, prodSame, prodLocal };
  }

  it('GET /price-suggestions — retourne uniquement les produits avec écart de prix', async () => {
    const s = await shop();
    const { prodDiff } = await setupProducts(s.id);

    const req = jsonRequest('/api/products/price-suggestions', undefined, { token: s.token });
    const resp = await getPriceSuggestions(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]._id.toString()).toBe(prodDiff._id.toString());
    expect(body.data[0].externalPrice).toBe(3500);
  });

  it('GET /price-suggestions — 401 sans token', async () => {
    const req = jsonRequest('/api/products/price-suggestions');
    const resp = await getPriceSuggestions(req);
    expect(resp.status).toBe(401);
  });

  it('POST /accept-external-price — applique le prix GestStock', async () => {
    const s = await shop();
    const { prodDiff } = await setupProducts(s.id);

    const req = jsonRequest(`/api/products/${prodDiff._id}/accept-external-price`, {}, { token: s.token });
    const resp = await acceptExternalPrice(req, { params: Promise.resolve({ id: prodDiff._id.toString() }) });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.data.price).toBe(3500);

    // Vérification en DB
    const updated = await Product.findById(prodDiff._id).lean();
    expect(updated?.price).toBe(3500);
  });

  it('POST /accept-external-price — 404 pour un produit local (sans external)', async () => {
    const s = await shop();
    const { prodLocal } = await setupProducts(s.id);

    const req = jsonRequest(`/api/products/${prodLocal._id}/accept-external-price`, {}, { token: s.token });
    const resp = await acceptExternalPrice(req, { params: Promise.resolve({ id: prodLocal._id.toString() }) });
    expect(resp.status).toBe(404);
  });

  it('POST /accept-external-price — 400 pour un produit GestStock sans externalPrice', async () => {
    const s = await shop();
    const shopOid = new mongoose.Types.ObjectId(s.id);
    const cat = await Category.create({ shopId: shopOid, name: 'Cat2', normalizedName: 'cat2', icon: 'i', color: '#f' });
    const prod = await Product.create({
      shopId: shopOid, categoryId: cat._id, name: 'Sans prix', price: 1000, image: '', description: '', unit: '', stock: 1, inStock: true,
      external: { source: 'geststock', id: 'gs-np', version: 1 },
    });

    const req = jsonRequest(`/api/products/${prod._id}/accept-external-price`, {}, { token: s.token });
    const resp = await acceptExternalPrice(req, { params: Promise.resolve({ id: prod._id.toString() }) });
    expect(resp.status).toBe(400);
  });

  it('POST /accept-external-price — 401 sans token', async () => {
    const req = jsonRequest('/api/products/fake-id/accept-external-price', {});
    const resp = await acceptExternalPrice(req, { params: Promise.resolve({ id: 'fake-id' }) });
    expect(resp.status).toBe(401);
  });
});
