import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';
import Product from '@/models/product.model';

// Un produit précis d'une boutique publique : sert au lien partagé
// `/shop/:slug?p=:id`, quand le produit n'est pas dans la première page chargée.
export async function GET(
  _req: Request,
  { params }: { params: { slug: string; id: string } }
) {
  try {
    if (!Types.ObjectId.isValid(params.id)) return res.notFound('Produit introuvable');

    await connectDB();
    const shop = await User.findOne({ slug: params.slug, banned: { $ne: true } }).select('_id').lean();
    if (!shop) return res.notFound('Boutique introuvable');

    const product = await Product.findOne({ _id: params.id, shopId: shop._id.toString() }).lean();
    if (!product) return res.notFound('Produit introuvable');

    return NextResponse.json(
      { success: true, data: product },
      { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=15' } }
    );
  } catch {
    return res.serverError();
  }
}
