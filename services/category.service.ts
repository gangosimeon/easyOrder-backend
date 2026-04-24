import Category from '@/models/category.model';
import Product from '@/models/product.model';
import { CreateCategoryInput, UpdateCategoryInput } from '@/validators/category.validator';

export async function getCategoriesByShop(shopId: string) {
  return Category.find({ shopId }).sort({ createdAt: 1 }).lean();
}

export async function getCategoryById(id: string, shopId: string) {
  const cat = await Category.findOne({ _id: id, shopId }).lean();
  if (!cat) throw Object.assign(new Error('Catégorie introuvable'), { status: 404 });
  return cat;
}

export async function createCategory(shopId: string, data: CreateCategoryInput) {
  return Category.create({ ...data, shopId });
}

export async function updateCategory(id: string, shopId: string, data: UpdateCategoryInput) {
  const cat = await Category.findOneAndUpdate(
    { _id: id, shopId },
    { $set: data },
    { new: true, runValidators: true }
  );
  if (!cat) throw Object.assign(new Error('Catégorie introuvable'), { status: 404 });
  return cat;
}

export async function deleteCategory(id: string, shopId: string) {
  const cat = await Category.findOneAndDelete({ _id: id, shopId });
  if (!cat) throw Object.assign(new Error('Catégorie introuvable'), { status: 404 });
  await Product.deleteMany({ categoryId: id, shopId });
  return cat;
}
