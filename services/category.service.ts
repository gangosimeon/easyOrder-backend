import Category from '@/models/category.model';
import Product from '@/models/product.model';
import { normalizeName } from '@/lib/normalize';
import { CreateCategoryInput, UpdateCategoryInput } from '@/validators/category.validator';

const DUPLICATE_NAME_MESSAGE = 'Cette catégorie existe déjà dans votre boutique.';

function duplicateNameError() {
  return Object.assign(new Error(DUPLICATE_NAME_MESSAGE), { status: 409 });
}

/** true si l'erreur vient de l'index unique {shopId, normalizedName} (E11000). */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Vérification applicative (message clair, avant écriture) — l'index unique
 * en base reste le garant final contre les créations concurrentes (voir
 * isDuplicateKeyError plus bas).
 */
async function assertNameAvailable(shopId: string, name: string, excludeId?: string): Promise<void> {
  const normalizedName = normalizeName(name);
  const query: Record<string, unknown> = { shopId, normalizedName };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await Category.exists(query);
  if (existing) throw duplicateNameError();
}

export async function getCategoriesByShop(shopId: string) {
  return Category.find({ shopId }).sort({ createdAt: 1 }).lean();
}

export async function getCategoryById(id: string, shopId: string) {
  const cat = await Category.findOne({ _id: id, shopId }).lean();
  if (!cat) throw Object.assign(new Error('Catégorie introuvable'), { status: 404 });
  return cat;
}

export async function createCategory(shopId: string, data: CreateCategoryInput) {
  await assertNameAvailable(shopId, data.name);
  try {
    return await Category.create({ ...data, shopId, normalizedName: normalizeName(data.name) });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateNameError();
    throw err;
  }
}

export async function updateCategory(id: string, shopId: string, data: UpdateCategoryInput) {
  if (data.name !== undefined) {
    await assertNameAvailable(shopId, data.name, id);
  }

  const patch: Record<string, unknown> = { ...data };
  if (data.name !== undefined) patch.normalizedName = normalizeName(data.name);

  try {
    const cat = await Category.findOneAndUpdate(
      { _id: id, shopId },
      { $set: patch },
      { new: true, runValidators: true }
    );
    if (!cat) throw Object.assign(new Error('Catégorie introuvable'), { status: 404 });
    return cat;
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateNameError();
    throw err;
  }
}

export async function deleteCategory(id: string, shopId: string) {
  const cat = await Category.findOneAndDelete({ _id: id, shopId });
  if (!cat) throw Object.assign(new Error('Catégorie introuvable'), { status: 404 });
  await Product.deleteMany({ categoryId: id, shopId });
  return cat;
}
