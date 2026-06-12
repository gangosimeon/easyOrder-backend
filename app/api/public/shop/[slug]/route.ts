import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { NextResponse } from 'next/server';
import User from '@/models/user.model';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import { getActiveAnnoncesByShop } from '@/services/annonce.service';

// ── GET /api/public/shop/[slug] ───────────────────────────────────────────────
// Params optionnels :
//   ?productPage=1   (page produits, défaut 1)
//   ?productLimit=20 (nb produits par page, défaut 20, max 100)
// Rétrocompatible : sans params → retourne les 20 premiers produits

export async function GET(
  req: Request,
  { params }: { params: { slug: string } }
) {
  try {
    await connectDB();

    const { searchParams } = new URL(req.url);
    const productPage  = Math.max(1, Number(searchParams.get('productPage')  ?? '1'));
    const productLimit = Math.min(Math.max(1, Number(searchParams.get('productLimit') ?? '20')), 100);
    const productSkip  = (productPage - 1) * productLimit;

    const shop = await User.findOne({ slug: params.slug }).select('-password').lean();
    if (!shop) return res.notFound('Boutique introuvable');

    const shopId = shop._id.toString();

    const [categories, productResult, announcements] = await Promise.all([
      Category.find({ shopId }).sort({ createdAt: 1 }).lean(),
      Product.find({ shopId })
        .sort({ createdAt: -1 })
        .skip(productSkip)
        .limit(productLimit)
        .lean(),
      getActiveAnnoncesByShop(shopId),
    ]);

    const productTotal = await Product.countDocuments({ shopId });

    const company = {
      id:          shopId,
      name:        shop.name,
      slug:        shop.slug,
      phone:       shop.phone,
      description: shop.description,
      address:     shop.address,
      logo:        shop.logo,
      coverColor:  shop.coverColor,
    };

    return NextResponse.json(
      {
        success: true,
        data: {
          company,
          categories,
          products:       productResult,
          announcements,
          productPage,
          productLimit,
          productTotal,
          productHasMore: productPage * productLimit < productTotal,
        },
      },
      { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=15' } }
    );
  } catch {
    return res.serverError();
  }
}
