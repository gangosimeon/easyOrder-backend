import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import Product from '@/models/product.model';

/**
 * POST /api/products/[id]/accept-external-price — applique le prix de référence GestStock (`externalPrice`)
 * comme prix de vente (`price`) du produit (lot 3, J11.2).
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);

    const product = await Product.findOne({
      _id: params.id,
      shopId: authUser.userId,
      'external.source': 'geststock',
    }).lean();
    if (!product) return res.notFound('Produit introuvable');
    if (product.externalPrice === undefined || product.externalPrice === null) {
      return res.badRequest('Ce produit n\'a pas de prix GestStock de référence');
    }

    const updated = await Product.findOneAndUpdate(
      { _id: params.id, shopId: authUser.userId },
      { $set: { price: product.externalPrice } },
      { new: true },
    ).lean();
    return res.ok(updated);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}
