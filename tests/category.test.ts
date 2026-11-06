import { beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

import { connectDB } from '@/lib/db';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import { deleteCategory } from '@/services/category.service';

/**
 * Service de catégories (lot 3, J10.3) :
 * protection 409 lors de la suppression d'une catégorie GestStock qui contient
 * encore des produits synchronisés visibles.
 */

describe('Category Service (lot 3, J10.3)', () => {
  beforeAll(async () => {
    await connectDB();
    await Category.init();
    await Product.init();
  });

  async function createShopId(): Promise<string> {
    const user = await mongoose.connection.collection('users').insertOne({
      name: 'Shop',
      phone: '70' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0'),
      countryCode: '226', password: 'hashed', role: 'user',
      slug: 'shop-cat-' + new mongoose.Types.ObjectId().toString(),
    });
    return user.insertedId.toString();
  }

  describe('Suppression catégorie GestStock (J10.3)', () => {
    it('catégorie GestStock avec produits synchro visibles → erreur 409', async () => {
      const shopId = await createShopId();
      const catId = 'cat-del-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'CatDel', normalizedName: 'catdel',
        external: { source: 'geststock', id: catId, version: 1 } });
      const prodId = 'prod-del-' + new mongoose.Types.ObjectId().toString();
      await Product.create({ shopId, categoryId: cat._id, name: 'Prod', price: 1000,
        visibleInShop: true, external: { source: 'geststock', id: prodId, version: 1 } });

      await expect(deleteCategory(cat._id.toString(), shopId)).rejects.toMatchObject({ status: 409 });
      // La catégorie doit encore exister (non supprimée)
      expect(await Category.findById(cat._id).lean()).not.toBeNull();
    });

    it('catégorie GestStock avec produits archivés uniquement (visibleInShop=false) → suppression réussie', async () => {
      const shopId = await createShopId();
      const catId = 'cat-del2-' + new mongoose.Types.ObjectId().toString();
      const cat = await Category.create({ shopId, name: 'CatDel2', normalizedName: 'catdel2',
        external: { source: 'geststock', id: catId, version: 1 } });
      // Produit archivé (visibleInShop=false) ne bloque pas
      await Product.create({ shopId, categoryId: cat._id, name: 'ProdArc', price: 1000,
        visibleInShop: false, external: { source: 'geststock', id: 'prod-arc-' + new mongoose.Types.ObjectId(), version: 1 } });

      await expect(deleteCategory(cat._id.toString(), shopId)).resolves.toBeDefined();
      expect(await Category.findById(cat._id).lean()).toBeNull();
    });

    it('catégorie non-GestStock (locale) → suppression réussie sans vérification', async () => {
      const shopId = await createShopId();
      const cat = await Category.create({ shopId, name: 'CatLocal', normalizedName: 'catlocal' });
      await Product.create({ shopId, categoryId: cat._id, name: 'Prod', price: 1000, visibleInShop: true });

      await expect(deleteCategory(cat._id.toString(), shopId)).resolves.toBeDefined();
      expect(await Category.findById(cat._id).lean()).toBeNull();
    });
  });
});
