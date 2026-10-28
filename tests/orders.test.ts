import { describe, expect, it } from 'vitest';
import { POST as createCategory } from '@/app/api/categories/route';
import { POST as createProduct } from '@/app/api/products/route';
import { POST as createOrder } from '@/app/api/orders/route';
import User from '@/models/user.model';
import { createShop, freshIp, jsonRequest } from './helpers';

async function shopWithProducts() {
  const shop = await createShop('Awa Mode', '70000010');
  const cat = await (await createCategory(jsonRequest('/api/categories', { name: 'Robes' }, { token: shop.token }))).json();
  const add = async (name: string, price: number, inStock = true) =>
    (await (await createProduct(jsonRequest('/api/products', { categoryId: cat.data._id, name, price, inStock }, { token: shop.token }))).json()).data._id as string;
  return { shop, robe: await add('Robe', 12000), foulard: await add('Foulard', 3000), epuise: await add('Sac', 9000, false) };
}

function order(productId: string, overrides: Record<string, unknown> = {}) {
  return {
    customerName: 'Fatou K.',
    customerPhone: '22670000099',
    items: [{ productId, price: 1, quantity: 2 }],
    total: 2,
    ...overrides,
  };
}

describe('POST /api/orders', () => {
  it('recalcule le total à partir des prix en base', async () => {
    const { shop, robe } = await shopWithProducts();
    const res = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe)));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.total).toBe(24000);
    expect(body.data.items[0].price).toBe(12000);
  });

  it('exige un nom et un numéro de téléphone valide', async () => {
    const { shop, robe } = await shopWithProducts();
    const noPhone = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe, { customerPhone: undefined })));
    expect(noPhone.status).toBe(400);
    const usFormat = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe, { customerPhone: '1(464)2163864' })));
    expect(usFormat.status).toBe(400);
    const noName = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe, { customerName: '' })));
    expect(noName.status).toBe(400);
  });

  it('refuse les quantités non entières ou démesurées', async () => {
    const { shop, robe } = await shopWithProducts();
    for (const quantity of [1.5, 0, 1000]) {
      const res = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`,
        order(robe, { items: [{ productId: robe, price: 1, quantity }] })));
      expect(res.status, `quantité ${quantity}`).toBe(400);
    }
  });

  it('rejette une requête dont le champ piège est rempli', async () => {
    const { shop, robe } = await shopWithProducts();
    const res = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe, { website: 'http://spam' })));
    expect(res.status).toBe(400);
  });

  it('refuse un produit indisponible', async () => {
    const { shop, epuise } = await shopWithProducts();
    const res = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(epuise)));
    expect(res.status).toBe(400);
  });

  it('refuse les commandes pour une boutique bannie', async () => {
    const { shop, robe } = await shopWithProducts();
    await User.updateOne({ _id: shop.id }, { banned: true });
    const res = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe)));
    expect(res.status).toBe(404);
  });

  it('limite le nombre de commandes par IP', async () => {
    const { shop, robe } = await shopWithProducts();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await createOrder(jsonRequest(`/api/orders?shopSlug=${shop.slug}`, order(robe), { ip }));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every(s => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
