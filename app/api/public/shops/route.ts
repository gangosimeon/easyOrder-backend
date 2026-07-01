import { connectDB }      from '@/lib/db';
import * as res           from '@/lib/api-response';
import User               from '@/models/user.model';
import { NextResponse }   from 'next/server';
import { PipelineStage }  from 'mongoose';
import { dialCodeToName } from '@/lib/country-utils';

interface PreviewProduct {
  id:    string;
  image: string;
  name:  string;
}

interface ShopCategory {
  name:  string;
  color: string;
  icon:  string;
}

interface PublicShopDTO {
  id:              string;
  name:            string;
  slug:            string;
  address:         string;
  logo:            string;
  coverColor:      string;
  /** Indicatif téléphonique du pays de la boutique (ex: "226"). */
  countryCode:     string;
  /** Nom du pays en français, calculé dynamiquement (jamais stocké en DB). */
  country:         string;
  productCount:    number;
  status:          'active' | 'inactive';
  categories:      ShopCategory[];
  previewProducts: PreviewProduct[];
}

interface ShopsListResponse {
  shops:      PublicShopDTO[];
  page:       number;
  limit:      number;
  totalPages: number;
  totalItems: number;
  hasMore:    boolean;
}

// ── GET /api/public/shops ─────────────────────────────────────────────────────
// Params : search, category, countryCode (optionnel), page (défaut 1), limit (défaut 25, max 100)
// Si countryCode est fourni : boutiques du même pays en premier, puis les autres.
// Aucune boutique n'est filtrée ou masquée.

export async function GET(req: Request) {
  try {
    await connectDB();

    const { searchParams } = new URL(req.url);
    const search      = searchParams.get('search')?.trim()      ?? '';
    const category    = searchParams.get('category')?.trim()    ?? '';
    const countryCode = searchParams.get('countryCode')?.trim() ?? '';
    const page        = Math.max(1, Number(searchParams.get('page')  ?? '1'));
    const limit       = Math.min(Math.max(1, Number(searchParams.get('limit') ?? '25')), 100);
    const skip        = (page - 1) * limit;

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

      // ── Compter les produits sans les charger en RAM ──────────────────────
      {
        $lookup: {
          from:     'products',
          let:      { sid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$shopId', '$$sid'] } } },
            { $count: 'n' },
          ],
          as: '_pCount',
        },
      },
      {
        $addFields: {
          productCount: { $ifNull: [{ $arrayElemAt: ['$_pCount.n', 0] }, 0] },
        },
      },
      { $match: { productCount: { $gt: 0 } } },

      // ── 4 images d'aperçu (champs minimaux) ──────────────────────────────
      {
        $lookup: {
          from:     'products',
          let:      { sid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$shopId', '$$sid'] }, image: { $ne: '' } } },
            { $sort:  { createdAt: -1 } },
            { $limit: 4 },
            { $project: { image: 1, name: 1 } },
          ],
          as: '_preview',
        },
      },

      // ── Catégories (champs minimaux) ──────────────────────────────────────
      {
        $lookup: {
          from:     'categories',
          let:      { sid: '$_id' },
          pipeline: [
            { $match:   { $expr: { $eq: ['$shopId', '$$sid'] } } },
            { $project: { name: 1, color: 1, icon: 1 } },
          ],
          as: '_cats',
        },
      },

      // Filtre par catégorie si fourni
      ...(category
        ? [{ $match: { '_cats.name': { $regex: `^${category}$`, $options: 'i' } } } as PipelineStage]
        : []),

      // ── Construire les champs de sortie ───────────────────────────────────
      {
        $addFields: {
          categories: {
            $map: {
              input: '$_cats',
              as:    'c',
              in:    { name: '$$c.name', color: '$$c.color', icon: '$$c.icon' },
            },
          },
          previewProducts: {
            $map: {
              input: '$_preview',
              as:    'p',
              in:    { id: { $toString: '$$p._id' }, image: '$$p.image', name: '$$p.name' },
            },
          },
        },
      },

      // ── Exclure les champs sensibles ──────────────────────────────────────
      // countryCode est conservé intentionnellement pour le tri et la réponse.
      {
        $project: {
          _pCount: 0, _preview: 0, _cats: 0,
          password: 0, phone: 0, email: 0, fullPhone: 0,
          recoveryEmail: 0, recoveryOtp: 0, resetOtp: 0,
        },
      },

      // ── Tri : pays du visiteur en tête, puis par productCount ─────────────
      // _isLocal = 0 pour le pays du visiteur (remonte), 1 pour les autres.
      // Sans countryCode, toutes les boutiques ont _isLocal = 1 : tri stable.
      {
        $addFields: {
          _isLocal: countryCode
            ? { $cond: [{ $eq: ['$countryCode', countryCode] }, 0, 1] }
            : { $literal: 1 },
        },
      },
      { $sort: { _isLocal: 1, productCount: -1 } },

      // ── Pagination + total en une seule passe ($facet) ────────────────────
      {
        $facet: {
          data:  [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }],
        },
      },
    ];

    type FacetResult = { data: Record<string, unknown>[]; total: [{ count: number }] | [] };
    const [result] = await (User.aggregate(pipeline) as unknown as Promise<FacetResult[]>);

    const raw        = result?.data  ?? [];
    const totalItems = result?.total?.[0]?.count ?? 0;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / limit) : 0;

    const shops: PublicShopDTO[] = raw.map(s => {
      const code = String(s.countryCode ?? '');
      return {
        id:           String(s._id),
        name:         String(s.name       ?? ''),
        slug:         String(s.slug       ?? ''),
        address:      String(s.address    ?? ''),
        logo:         String(s.logo       ?? ''),
        coverColor:   String(s.coverColor ?? '#E8521A'),
        countryCode:  code,
        country:      dialCodeToName(code) ?? '',
        productCount: Number(s.productCount ?? 0),
        status:       'active',
        categories: Array.isArray(s.categories)
          ? (s.categories as ShopCategory[]).map(c => ({
              name:  String(c.name  ?? ''),
              color: String(c.color ?? '#FF6B35'),
              icon:  String(c.icon  ?? 'inventory_2'),
            }))
          : [],
        previewProducts: Array.isArray(s.previewProducts)
          ? (s.previewProducts as Array<{ id?: unknown; image?: unknown; name?: unknown }>).map(p => ({
              id:    String(p.id    ?? ''),
              image: String(p.image ?? ''),
              name:  String(p.name  ?? ''),
            }))
          : [],
      };
    });

    const response: ShopsListResponse = {
      shops,
      page,
      limit,
      totalPages,
      totalItems,
      hasMore: page < totalPages,
    };

    return NextResponse.json(
      { success: true, data: response },
      { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=30' } }
    );
  } catch {
    return res.serverError();
  }
}
