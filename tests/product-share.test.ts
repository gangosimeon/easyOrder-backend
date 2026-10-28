import { describe, expect, it } from 'vitest';
import { POST as createCategory } from '@/app/api/categories/route';
import { POST as createProduct } from '@/app/api/products/route';
import { GET as getPublicProduct } from '@/app/api/public/shop/[slug]/products/[id]/route';
import { getProductOGData, productOgImage } from '@/lib/shop-og';
import User from '@/models/user.model';
import { createShop, jsonRequest } from './helpers';

async function shopWithProduct(phone: string) {
  const shop = await createShop('Awa Mode', phone);
  const cat = await (await createCategory(jsonRequest('/api/categories', { name: 'Robes' }, { token: shop.token }))).json();
  const prod = await (await createProduct(jsonRequest('/api/products', {
    categoryId: cat.data._id, name: 'Robe wax', price: 12000,
    image: 'https://res.cloudinary.com/demo/image/upload/v1/robe.jpg',
  }, { token: shop.token }))).json();
  return { shop, productId: prod.data._id as string };
}

const get = (slug: string, id: string) =>
  getPublicProduct(jsonRequest(`/api/public/shop/${slug}/products/${id}`), { params: { slug, id } });

describe('lien de partage produit', () => {
  it('renvoie le produit de la boutique', async () => {
    const { shop, productId } = await shopWithProduct('70000040');
    const res = await get(shop.slug, productId);
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Robe wax');
  });

  it("ne renvoie pas le produit d'une autre boutique sous ce slug", async () => {
    const { productId } = await shopWithProduct('70000041');
    const other = await createShop('Autre boutique', '70000042');
    expect((await get(other.slug, productId)).status).toBe(404);
    expect((await get(other.slug, 'pas-un-id')).status).toBe(404);
  });

  it("n'expose plus les produits d'une boutique bannie", async () => {
    const { shop, productId } = await shopWithProduct('70000043');
    await User.updateOne({ _id: shop.id }, { banned: true });
    expect((await get(shop.slug, productId)).status).toBe(404);
    expect(await getProductOGData(shop.slug, productId)).toBeNull();
  });

  it("donne le prix facturé et une image d'aperçu 1200×630", async () => {
    const { shop, productId } = await shopWithProduct('70000044');
    const og = await getProductOGData(shop.slug, productId);
    expect(og?.price).toBe(12000);
    expect(productOgImage(og!.image)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_pad,b_white,w_1200,h_630,f_jpg,q_auto/v1/robe.jpg');
    expect(productOgImage('https://exemple.com/a.jpg')).toBe('https://exemple.com/a.jpg');
  });
});
