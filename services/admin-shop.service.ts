import mongoose, { PipelineStage } from 'mongoose';
import User from '@/models/user.model';
import Product from '@/models/product.model';
import Category from '@/models/category.model';
import Order from '@/models/order.model';
import ShopVisit from '@/models/shop-visit.model';
import { buildBaseMatchStage, resolveSort, ShopsFilter, SortParams } from '@/lib/query-builder';
import { buildPaginationMeta, PaginationMeta } from '@/lib/pagination';

// ── DTOs ────────────────────────────────────────────────────────────────────

export interface AdminShopDTO {
  id:           string;
  name:         string;
  slug:         string;
  phone:        string;
  description:  string;
  logo:         string;
  address:      string;
  coverColor:   string;
  createdAt:    Date;
  productCount: number;
  status:       'active' | 'inactive';
  publicUrl:    string;
}

export interface AdminShopDetailDTO extends AdminShopDTO {
  categoryCount:  number;
  orderCount:     number;
  recentProducts: RecentProductDTO[];
}

export interface RecentProductDTO {
  id:        string;
  name:      string;
  price:     number;
  image:     string;
  inStock:   boolean;
  createdAt: Date;
}

export interface AdminShopsResult {
  shops:      AdminShopDTO[];
  pagination: PaginationMeta;
}

// ── Private transformer ──────────────────────────────────────────────────────

function toDTO(shop: Record<string, unknown>, baseUrl: string): AdminShopDTO {
  return {
    id:           String(shop._id),
    name:         String(shop.name         ?? ''),
    slug:         String(shop.slug         ?? ''),
    phone:        String(shop.phone        ?? ''),
    description:  String(shop.description  ?? ''),
    logo:         String(shop.logo         ?? ''),
    address:      String(shop.address      ?? ''),
    coverColor:   String(shop.coverColor   ?? '#000000'),
    createdAt:    shop.createdAt as Date,
    productCount: Number(shop.productCount ?? 0),
    status:       (shop.status as 'active' | 'inactive') ?? 'inactive',
    publicUrl:    `${baseUrl}/shop/${String(shop.slug ?? '')}`,
  };
}

// ── listAdminShops ───────────────────────────────────────────────────────────

export async function listAdminShops(
  filter:     ShopsFilter,
  sort:       SortParams,
  pagination: { page: number; limit: number },
  baseUrl:    string,
): Promise<AdminShopsResult> {
  const match            = buildBaseMatchStage(filter);
  const { field, dir }   = resolveSort(sort);
  const skip             = (pagination.page - 1) * pagination.limit;

  const pipeline = ([
    { $match: match },
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
    { $project: { _products: 0, password: 0 } },
    ...(filter.status && filter.status !== 'all'
      ? [{ $match: { status: filter.status } }]
      : []
    ),
    { $sort: { [field]: dir } },
    {
      $facet: {
        data:  [{ $skip: skip }, { $limit: pagination.limit }],
        total: [{ $count: 'count' }],
      },
    },
  ] as unknown as PipelineStage[]);

  type FacetResult = { data: Record<string, unknown>[]; total: Array<{ count: number }> };
  const [result] = await (User.aggregate(pipeline) as unknown as Promise<FacetResult[]>);

  const shops = (result?.data ?? []).map(s => toDTO(s, baseUrl));
  const total = result?.total?.[0]?.count ?? 0;

  return { shops, pagination: buildPaginationMeta(total, pagination.page, pagination.limit) };
}

// ── getAdminShopById ─────────────────────────────────────────────────────────

export async function getAdminShopById(
  shopId:  string,
  baseUrl: string,
): Promise<AdminShopDetailDTO | null> {
  const shop = await User.findById(shopId).select('-password').lean();
  if (!shop) return null;

  const id = String(shop._id);

  const [productCount, categoryCount, orderCount, rawProducts] = await Promise.all([
    Product.countDocuments({ shopId: id }),
    Category.countDocuments({ shopId: id }),
    Order.countDocuments({ shopId: id }),
    Product.find({ shopId: id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name price image inStock createdAt')
      .lean(),
  ]);

  const status: 'active' | 'inactive' = productCount > 0 ? 'active' : 'inactive';
  const base = toDTO(
    { ...(shop as unknown as Record<string, unknown>), productCount, status },
    baseUrl,
  );

  const recentProducts: RecentProductDTO[] = rawProducts.map(p => ({
    id:        String(p._id),
    name:      String((p as unknown as Record<string, unknown>).name   ?? ''),
    price:     Number((p as unknown as Record<string, unknown>).price  ?? 0),
    image:     String((p as unknown as Record<string, unknown>).image  ?? ''),
    inStock:   Boolean((p as unknown as Record<string, unknown>).inStock),
    createdAt: (p as unknown as Record<string, unknown>).createdAt as Date,
  }));

  return { ...base, categoryCount, orderCount, recentProducts };
}

// ── getAdminShopStats ────────────────────────────────────────────────────────

export async function getAdminShopStats(shopId: string) {
  let oid: mongoose.Types.ObjectId;
  try {
    oid = new mongoose.Types.ObjectId(shopId);
  } catch {
    return null;
  }

  const shop = await User.findById(oid).select('name slug').lean();
  if (!shop) return null;

  const now            = new Date();
  const thirtyDaysAgo  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const today          = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [productCount, categoryCount, orderCount, recentOrderCount, visitData] =
    await Promise.all([
      Product.countDocuments({ shopId }),
      Category.countDocuments({ shopId }),
      Order.countDocuments({ shopId }),
      Order.countDocuments({ shopId, createdAt: { $gte: thirtyDaysAgo } }),
      ShopVisit.aggregate([
        { $match: { shopId: oid } },
        {
          $facet: {
            total:  [{ $count: 'count' }],
            unique: [{ $group: { _id: '$visitorId' } }, { $count: 'count' }],
            today:  [{ $match: { visitedAt: { $gte: today } } }, { $count: 'count' }],
            perDay: [
              { $match: { visitedAt: { $gte: thirtyDaysAgo } } },
              {
                $group: {
                  _id:   { $dateToString: { format: '%Y-%m-%d', date: '$visitedAt' } },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ]),
    ]);

  type VisitFacet = Record<string, Array<{ count?: number; _id?: string }>>;
  const v = (visitData[0] as VisitFacet) ?? {};

  return {
    shopId,
    shopName:         String(shop.name),
    shopSlug:         String(shop.slug),
    productCount,
    categoryCount,
    orderCount,
    recentOrderCount,
    visits: {
      total:  v.total?.[0]?.count  ?? 0,
      unique: v.unique?.[0]?.count ?? 0,
      today:  v.today?.[0]?.count  ?? 0,
      perDay: (v.perDay ?? []).map(d => ({ date: d._id, count: d.count ?? 0 })),
    },
  };
}

// ── getAggregateShopStats ────────────────────────────────────────────────────

export async function getAggregateShopStats() {
  const now          = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [summary, monthlyGrowth, topShops] = await Promise.all([
    User.aggregate([
      { $match: { role: 'user' } },
      {
        $lookup: {
          from: 'products', localField: '_id', foreignField: 'shopId', as: '_p',
        },
      },
      {
        $addFields: {
          productCount: { $size: '$_p' },
          status: { $cond: [{ $gt: [{ $size: '$_p' }, 0] }, 'active', 'inactive'] },
        },
      },
      {
        $group: {
          _id:           null,
          totalShops:    { $sum: 1 },
          activeShops:   { $sum: { $cond: [{ $eq: ['$status', 'active'],    }, 1, 0] } },
          inactiveShops: { $sum: { $cond: [{ $eq: ['$status', 'inactive'],  }, 1, 0] } },
          totalProducts: { $sum: '$productCount' },
        },
      },
    ]),

    User.aggregate([
      { $match: { role: 'user', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    User.aggregate([
      { $match: { role: 'user' } },
      {
        $lookup: {
          from: 'products', localField: '_id', foreignField: 'shopId', as: '_p',
        },
      },
      { $addFields: { productCount: { $size: '$_p' } } },
      { $project: { password: 0, _p: 0 } },
      { $sort: { productCount: -1 } },
      { $limit: 5 },
    ]),
  ]);

  type SummaryRow = { totalShops: number; activeShops: number; inactiveShops: number; totalProducts: number };
  const s = (summary[0] as SummaryRow | undefined) ?? {
    totalShops: 0, activeShops: 0, inactiveShops: 0, totalProducts: 0,
  };

  return {
    totalShops:    s.totalShops,
    activeShops:   s.activeShops,
    inactiveShops: s.inactiveShops,
    totalProducts: s.totalProducts,
    monthlyGrowth: (monthlyGrowth as Array<{ _id: string; count: number }>).map(m => ({
      month: m._id, count: m.count,
    })),
    topShops: (topShops as Array<Record<string, unknown>>).map(t => ({
      id:           String(t._id),
      name:         String(t.name),
      slug:         String(t.slug),
      productCount: Number(t.productCount),
    })),
  };
}
