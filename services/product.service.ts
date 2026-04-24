import Product from '@/models/product.model';
import Category from '@/models/category.model';
import { CreateProductInput, UpdateProductInput } from '@/validators/product.validator';

export async function getProductsByShop(shopId: string, categoryId?: string) {
  const filter: Record<string, string> = { shopId };
  if (categoryId) filter.categoryId = categoryId;
  return Product.find(filter).sort({ createdAt: -1 }).lean();
}

export async function getProductById(id: string, shopId: string) {
  const prod = await Product.findOne({ _id: id, shopId }).lean();
  if (!prod) throw Object.assign(new Error('Produit introuvable'), { status: 404 });
  return prod;
}

export async function createProduct(shopId: string, data: CreateProductInput) {
  const catExists = await Category.exists({ _id: data.categoryId, shopId });
  if (!catExists) {
    throw Object.assign(new Error('Catégorie introuvable pour cette boutique'), { status: 400 });
  }
  return Product.create({ ...data, shopId });
}

export async function updateProduct(id: string, shopId: string, data: UpdateProductInput) {
  if (data.categoryId) {
    const catExists = await Category.exists({ _id: data.categoryId, shopId });
    if (!catExists) {
      throw Object.assign(new Error('Catégorie introuvable pour cette boutique'), { status: 400 });
    }
  }
  const prod = await Product.findOneAndUpdate(
    { _id: id, shopId },
    { $set: data },
    { new: true, runValidators: true }
  );
  if (!prod) throw Object.assign(new Error('Produit introuvable'), { status: 404 });
  return prod;
}

export async function deleteProduct(id: string, shopId: string) {
  const prod = await Product.findOneAndDelete({ _id: id, shopId });
  if (!prod) throw Object.assign(new Error('Produit introuvable'), { status: 404 });
  return prod;
}

export async function deleteProductsByCategory(categoryId: string, shopId: string) {
  return Product.deleteMany({ categoryId, shopId });
}
