import { connectDB } from './db';
import User from '@/models/user.model';
import Product from '@/models/product.model';

interface ShopLean {
  _id:          { toString(): string };
  name?:        string;
  slug?:        string;
  description?: string;
  address?:     string;
  logo?:        string;
  coverColor?:  string;
  phone?:       string;
}

interface ProductLean {
  name?:  string;
  price?: number;
  image?: string;
}

export interface ShopOGData {
  name:        string;
  slug:        string;
  description: string;
  address:     string;
  logo:        string;
  coverColor:  string;
  phone:       string;
  products: Array<{
    name:  string;
    price: number;
    image: string;
  }>;
}

interface CacheEntry {
  data:      ShopOGData;
  expiresAt: number;
}

// ── In-memory cache : slug → { data, expiresAt } ──────────────────────────────
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000; // 1 heure

// ── Lecture des données boutique (avec cache) ──────────────────────────────────
export async function getShopOGData(slug: string): Promise<ShopOGData | null> {
  const now    = Date.now();
  const cached = cache.get(slug);
  if (cached && cached.expiresAt > now) return cached.data;

  try {
    await connectDB();

    const shop = await User.findOne({ slug })
      .select('name slug description address logo coverColor phone')
      .lean() as ShopLean | null;

    if (!shop) return null;

    const products = await Product.find({ shopId: shop._id.toString(), inStock: true })
      .select('name price image')
      .sort({ createdAt: -1 })
      .limit(4)
      .lean() as ProductLean[];

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

// ── Invalide le cache pour un slug donné ──────────────────────────────────────
export function invalidateShopOGCache(slug: string): boolean {
  return cache.delete(slug);
}

// ── Invalide tout le cache (utilisé au redémarrage ou en urgence) ─────────────
export function clearAllOGCache(): void {
  cache.clear();
}

// ── Retourne les stats du cache (utile pour le monitoring) ────────────────────
export function getOGCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function isImageUrl(value?: string): boolean {
  return !!value && (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('data:image/')
  );
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat('fr-FR').format(price) + ' FCFA';
}
