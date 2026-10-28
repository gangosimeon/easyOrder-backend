import { describe, expect, it } from 'vitest';
import { POST as createCategory } from '@/app/api/categories/route';
import { GET as listProducts, POST as createProduct } from '@/app/api/products/route';
import { GET as getProduct, PUT as updateProduct, DELETE as deleteProduct } from '@/app/api/products/[id]/route';
import { createShop, jsonRequest } from './helpers';

// Garantie centrale du multi-boutiques : un commerçant ne peut ni lire, ni
// modifier, ni supprimer les données d'un autre.
describe('isolation entre boutiques', () => {
  async function shopWithProduct() {
    const a = await createShop('Boutique A', '70000001');
    const b = await createShop('Boutique B', '70000002');
    const cat = await (await createCategory(jsonRequest('/api/categories', { name: 'Robes' }, { token: a.token }))).json();
    const prod = await (await createProduct(jsonRequest('/api/products', {
      categoryId: cat.data._id, name: 'Robe wax', price: 12000,
    }, { token: a.token }))).json();
    return { a, b, productId: prod.data._id as string };
  }

  it('B ne voit pas le produit de A', async () => {
    const { b, productId } = await shopWithProduct();
    const res = await getProduct(jsonRequest(`/api/products/${productId}`, undefined, { token: b.token }), { params: { id: productId } });
    expect(res.status).toBe(404);

    const list = await (await listProducts(jsonRequest('/api/products', undefined, { token: b.token }))).json();
    expect(list.data).toHaveLength(0);
  });

  it('B ne peut ni modifier ni supprimer le produit de A', async () => {
    const { a, b, productId } = await shopWithProduct();
    const put = await updateProduct(
      jsonRequest(`/api/products/${productId}`, { price: 1 }, { token: b.token, method: 'PUT' }),
      { params: { id: productId } },
    );
    expect(put.status).toBe(404);

    const del = await deleteProduct(
      jsonRequest(`/api/products/${productId}`, undefined, { token: b.token, method: 'DELETE' }),
      { params: { id: productId } },
    );
    expect(del.status).toBe(404);

    const stillThere = await (await getProduct(jsonRequest(`/api/products/${productId}`, undefined, { token: a.token }), { params: { id: productId } })).json();
    expect(stillThere.data.price).toBe(12000);
  });
});
