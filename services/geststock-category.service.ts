import mongoose from 'mongoose';

import Category from '@/models/category.model';
import Product from '@/models/product.model';

/**
 * Rapprochement des catégories GestStock et locales (lot 3, J11).
 *
 * Quand un événement UPSERT CATEGORY échoue avec E11000 (nom normalisé déjà pris par une catégorie locale),
 * la boutique peut rapprocher manuellement les deux catégories ici :
 *  - GET  /unmatched         : listes des catégories GestStock et locales côte à côte.
 *  - POST /match-category    : fusionne une catégorie locale dans une catégorie GestStock (produits migrés,
 *                              catégorie locale supprimée).
 */

/** Catégorie telle que renvoyée dans les listes de rapprochement. */
export interface UnmatchedCategoryItem {
  _id: string;
  name: string;
  icon: string;
  color: string;
}

export interface UnmatchedCategoriesResult {
  geststockCategories: UnmatchedCategoryItem[];
  localCategories: UnmatchedCategoryItem[];
}

/** Listes des catégories GestStock et locales (sans `external`) de la boutique. */
export async function getUnmatchedCategories(shopId: string): Promise<UnmatchedCategoriesResult> {
  if (!mongoose.isValidObjectId(shopId)) return { geststockCategories: [], localCategories: [] };
  const [geststockDocs, localDocs] = await Promise.all([
    Category.find({ shopId, 'external.source': 'geststock' }).sort({ name: 1 }).select('name icon color').lean(),
    Category.find({ shopId, external: { $exists: false } }).sort({ name: 1 }).select('name icon color').lean(),
  ]);
  const toItem = (d: { _id: mongoose.Types.ObjectId; name: string; icon: string; color: string }): UnmatchedCategoryItem => ({
    _id: d._id.toString(),
    name: d.name,
    icon: d.icon,
    color: d.color,
  });
  return {
    geststockCategories: geststockDocs.map(toItem),
    localCategories: localDocs.map(toItem),
  };
}

/**
 * Fusionne une catégorie locale dans une catégorie GestStock :
 * - Les produits de la catégorie locale sont déplacés dans la catégorie GestStock.
 * - La catégorie locale est supprimée.
 * @throws `{ status: 404 }` si l'une des catégories est introuvable ou n'appartient pas à la boutique.
 */
export async function matchCategory(shopId: string, geststockCategoryId: string, localCategoryId: string): Promise<{ matchedCategoryId: string }> {
  const [geststockCat, localCat] = await Promise.all([
    Category.findOne({ _id: geststockCategoryId, shopId, 'external.source': 'geststock' }).lean(),
    Category.findOne({ _id: localCategoryId, shopId, external: { $exists: false } }).lean(),
  ]);
  if (!geststockCat) throw Object.assign(new Error('Catégorie GestStock introuvable'), { status: 404 });
  if (!localCat) throw Object.assign(new Error('Catégorie locale introuvable'), { status: 404 });

  await Product.updateMany(
    { categoryId: new mongoose.Types.ObjectId(localCategoryId), shopId },
    { $set: { categoryId: geststockCat._id } },
  );
  await Category.deleteOne({ _id: localCategoryId });

  return { matchedCategoryId: geststockCategoryId };
}
