import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';
import { PipelineStage } from 'mongoose';

interface ShopCategory {
  name:  string;
  color: string;
  icon:  string;
}

interface PublicShopDTO {
  id:           string;
  name:         string;
  slug:         string;
  address:      string;
  logo:         string;
  coverColor:   string;
  productCount: number;
  status:       'active' | 'inactive';
  categories:   ShopCategory[];
}

// ── GET /api/public/shops ─────────────────────────────────────────────────────
// Pas d'authentification requise
// Params : search, category, limit

export async function GET(req: Request) {
  try {
    await connectDB();

    const { searchParams } = new URL(req.url);
    const search   = searchParams.get('search')?.trim()   ?? '';
    const category = searchParams.get('category')?.trim() ?? '';
    const limit    = Math.min(Number(searchParams.get('limit') ?? '50'), 100);

    const matchStage: Record<string, unknown> = {
      role:     'user',
      isActive: { $ne: false },
    };

    if (search) {
      matchStage['$or'] = [
        { name:    { $regex: search, $options: 'i' } },
        { address: { $regex: search, $options: 'i' } },
      ];
    }

    const pipeline: PipelineStage[] = [
      { $match: matchStage },

      // Produits → productCount + status
      {
        $lookup: {
          from:         'products',
          localField:   '_id',
          foreignField: 'shopId',
          as:           '_products',
        },
      },
      {
        $addFields: {
          productCount: { $size: '$_products' },
          status: {
            $cond: [{ $gt: [{ $size: '$_products' }, 0] }, 'active', 'inactive'],
          },
        },
      },
      { $match: { status: 'active' } },

      // Catégories → pour filtre + badge
      {
        $lookup: {
          from:         'categories',
          localField:   '_id',
          foreignField: 'shopId',
          as:           '_cats',
        },
      },

      // Filtre par catégorie si fourni
      ...(category
        ? [{ $match: { '_cats.name': { $regex: `^${category}$`, $options: 'i' } } } as PipelineStage]
        : []),

      // Transformer _cats → categories (DTO propre)
      {
        $addFields: {
          categories: {
            $map: {
              input: '$_cats',
              as:    'c',
              in:    { name: '$$c.name', color: '$$c.color', icon: '$$c.icon' },
            },
          },
        },
      },

      {
        $project: {
          _products: 0, _cats: 0,
          password: 0, phone: 0, email: 0, countryCode: 0, fullPhone: 0,
        },
      },

      { $sort:  { productCount: -1 } },
      { $limit: limit },
    ];

    const raw = await (User.aggregate(pipeline) as unknown as Promise<Record<string, unknown>[]>);

    const shops: PublicShopDTO[] = raw.map(s => ({
      id:           String(s._id),
      name:         String(s.name       ?? ''),
      slug:         String(s.slug       ?? ''),
      address:      String(s.address    ?? ''),
      logo:         String(s.logo       ?? ''),
      coverColor:   String(s.coverColor ?? '#E8521A'),
      productCount: Number(s.productCount ?? 0),
      status:       'active',
      categories:   Array.isArray(s.categories)
        ? (s.categories as ShopCategory[]).map(c => ({
            name:  String(c.name  ?? ''),
            color: String(c.color ?? '#FF6B35'),
            icon:  String(c.icon  ?? 'inventory_2'),
          }))
        : [],
    }));

    return res.ok(shops);
  } catch {
    return res.serverError();
  }
}
