import { connectDB } from './db';
import User from '@/models/user.model';
import Product from '@/models/product.model';

export interface ShopOGData {
  name: string;
  slug: string;
  description: string;
  address: string;
  logo: string;
  coverColor: string;
  phone: string;
  products: Array<{
    name: string;
    price: number;
    image: string;
  }>;
}

/** In-memory cache: slug → { data, expiresAt } */
const cache = new Map<string, { data: ShopOGData; expiresAt: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getShopOGData(slug: string): Promise<ShopOGData | null> {
  const now = Date.now();
  const cached = cache.get(slug);
  if (cached && cached.expiresAt > now) return cached.data;

  try {
    await connectDB();

    const shop = await User.findOne({ slug })
      .select('name slug description address logo coverColor phone')
      .lean();

    if (!shop) return null;

    const products = await Product.find({ shopId: shop._id.toString(), inStock: true })
      .select('name price image')
      .sort({ createdAt: -1 })
      .limit(4)
      .lean();

    const data: ShopOGData = {
      name:        shop.name        ?? '',
      slug:        shop.slug        ?? slug,
      description: shop.description ?? '',
      address:     shop.address     ?? '',
      logo:        shop.logo        ?? '🏪',
      coverColor:  shop.coverColor  ?? '#a04343',
      phone:       shop.phone       ?? '',
      products: products.map(p => ({
        name:  p.name  ?? '',
        price: p.price ?? 0,
        image: p.image ?? '',
      })),
    };

    cache.set(slug, { data, expiresAt: now + TTL_MS });
    return data;
  } catch {
    return null;
  }
}

export function isImageUrl(value?: string): boolean {
  return !!value && (value.startsWith('http') || value.startsWith('https') || value.startsWith('data:'));
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat('fr-FR').format(price) + ' FCFA';
}
