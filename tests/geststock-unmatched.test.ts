import { beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import { signToken } from '@/lib/auth';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import User from '@/models/user.model';
import { GET as getUnmatched } from '@/app/api/integrations/geststock/unmatched/route';
import { POST as matchCategory } from '@/app/api/integrations/geststock/match-category/route';
import { createShop, jsonRequest } from './helpers';

/**
 * Routes de rapprochement des catégories (lot 3, J11.1) :
 * GET  /api/integrations/geststock/unmatched
 * POST /api/integrations/geststock/match-category
 */

let phoneCounter = 0;
function phone(): string {
  phoneCounter += 1;
  return `77${String(phoneCounter).padStart(6, '0')}`;
}

describe('Rapprochement des catégories GestStock (lot 3, J11)', () => {
  beforeAll(async () => {
    await connectDB();
    await Category.init();
    await Product.init();
  });

  /** Boutique approuvée non bannie. */
  async function shop() {
    const s = await createShop('Boutique J11', phone());
    await User.updateOne({ _id: s.id }, { isActive: true });
    return s;
  }

  async function geststockRequest(handler: (req: Request) => Promise<Response>, url: string, body?: unknown, token?: string) {
    const req = jsonRequest(url, body, { token, method: body === undefined ? 'GET' : 'POST' });
    const resp = await handler(req);
    return { status: resp.status, json: await resp.json() };
  }

  it('GET /unmatched — retourne catégories GestStock et locales', async () => {
    const s = await shop();
    const shopOid = new mongoose.Types.ObjectId(s.id);

    await Category.create([
      { shopId: shopOid, name: 'Chaussures', normalizedName: 'chaussures', icon: 'i', color: '#fff',
        external: { source: 'geststock', id: 'ext-1', version: 1 } },
      { shopId: shopOid, name: 'Vêtements', normalizedName: 'vetements', icon: 'i', color: '#fff',
        external: { source: 'geststock', id: 'ext-2', version: 1 } },
      { shopId: shopOid, name: 'Accessoires', normalizedName: 'accessoires', icon: 'i', color: '#fff' },
    ]);

    // Env minimal requis par geststockRoute
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    const { status, json } = await geststockRequest(getUnmatched, '/api/integrations/geststock/unmatched', undefined, s.token);
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;

    expect(status).toBe(200);
    expect(json.data.geststockCategories).toHaveLength(2);
    expect(json.data.localCategories).toHaveLength(1);
    expect(json.data.localCategories[0].name).toBe('Accessoires');
  });

  it('POST /match-category — déplace les produits et supprime la catégorie locale', async () => {
    const s = await shop();
    const shopOid = new mongoose.Types.ObjectId(s.id);

    const [gsCat, localCat] = await Category.create([
      { shopId: shopOid, name: 'Chaussures GS', normalizedName: 'chaussures-gs', icon: 'i', color: '#fff',
        external: { source: 'geststock', id: 'ext-gs', version: 1 } },
      { shopId: shopOid, name: 'Chaussures Local', normalizedName: 'chaussures-local', icon: 'i', color: '#fff' },
    ]);

    // Produits dans la catégorie locale
    await Product.create([
      { shopId: shopOid, categoryId: localCat._id, name: 'Chaussure A', price: 5000, image: '', description: '', unit: '', stock: 1, inStock: true },
      { shopId: shopOid, categoryId: localCat._id, name: 'Chaussure B', price: 6000, image: '', description: '', unit: '', stock: 2, inStock: true },
    ]);

    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    const { status, json } = await geststockRequest(
      matchCategory,
      '/api/integrations/geststock/match-category',
      { geststockCategoryId: gsCat._id.toString(), localCategoryId: localCat._id.toString() },
      s.token,
    );
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;

    expect(status).toBe(200);
    expect(json.data.matchedCategoryId).toBe(gsCat._id.toString());

    // Catégorie locale supprimée
    expect(await Category.findById(localCat._id).lean()).toBeNull();
    // Catégorie GestStock conservée
    expect(await Category.findById(gsCat._id).lean()).not.toBeNull();
    // Produits migrés vers la catégorie GestStock
    const products = await Product.find({ shopId: shopOid, categoryId: gsCat._id }).lean();
    expect(products).toHaveLength(2);
  });

  it('POST /match-category — 404 si catégorie GestStock inconnue', async () => {
    const s = await shop();
    const shopOid = new mongoose.Types.ObjectId(s.id);
    const localCat = await Category.create({ shopId: shopOid, name: 'Local', normalizedName: 'local', icon: 'i', color: '#fff' });

    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    const { status } = await geststockRequest(
      matchCategory,
      '/api/integrations/geststock/match-category',
      { geststockCategoryId: new mongoose.Types.ObjectId().toString(), localCategoryId: localCat._id.toString() },
      s.token,
    );
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;

    expect(status).toBe(404);
  });

  it('POST /match-category — 404 si catégorie locale inconnue', async () => {
    const s = await shop();
    const shopOid = new mongoose.Types.ObjectId(s.id);
    const gsCat = await Category.create({ shopId: shopOid, name: 'GS', normalizedName: 'gs', icon: 'i', color: '#fff',
      external: { source: 'geststock', id: 'ext-x', version: 1 } });

    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    const { status } = await geststockRequest(
      matchCategory,
      '/api/integrations/geststock/match-category',
      { geststockCategoryId: gsCat._id.toString(), localCategoryId: new mongoose.Types.ObjectId().toString() },
      s.token,
    );
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;

    expect(status).toBe(404);
  });

  it('GET /unmatched — 401 sans token', async () => {
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    const { status } = await geststockRequest(getUnmatched, '/api/integrations/geststock/unmatched');
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;
    expect(status).toBe(401);
  });
});
