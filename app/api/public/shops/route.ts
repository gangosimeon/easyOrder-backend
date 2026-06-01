import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';
import Product from '@/models/product.model';
import { PipelineStage } from 'mongoose';

// ── DTO aligné sur PublicShopInfo (frontend) ──────────────────────────────────

interface PublicShopDTO {
  id:           string;
  name:         string;
  slug:         string;
  address:      string;
  logo:         string;
  coverColor:   string;
  productCount: number;
  status:       'active' | 'inactive';
}

// ── GET /api/public/shops ─────────────────────────────────────────────────────
// Pas d'authentification requise — accessible publiquement

export async function GET(req: Request) {
  try {
    await connectDB();

    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search')?.trim() ?? '';
    const limit  = Math.min(Number(searchParams.get('limit') ?? '50'), 100);

    const matchStage: Record<string, unknown> = { role: 'user' };
    if (search) {
      matchStage['$or'] = [
        { name:    { $regex: search, $options: 'i' } },
        { address: { $regex: search, $options: 'i' } },
      ];
    }

    const pipeline: PipelineStage[] = [
      { $match: matchStage },
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
      // N'exposer que les boutiques actives (au moins 1 produit)
      { $match: { status: 'active' } },
      { $project: { _products: 0, password: 0, phone: 0, email: 0 } },
      { $sort: { productCount: -1 } },
      { $limit: limit },
    ];

    const raw = await (User.aggregate(pipeline) as unknown as Promise<Record<string, unknown>[]>);

    const shops: PublicShopDTO[] = raw.map(s => ({
      id:           String(s._id),
      name:         String(s.name         ?? ''),
      slug:         String(s.slug         ?? ''),
      address:      String(s.address      ?? ''),
      logo:         String(s.logo         ?? ''),
      coverColor:   String(s.coverColor   ?? '#E8521A'),
      productCount: Number(s.productCount ?? 0),
      status:       'active',
    }));

    return res.ok(shops);
  } catch {
    return res.serverError();
  }
}
