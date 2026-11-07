import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import Product from '@/models/product.model';

/**
 * GET /api/products/price-suggestions — produits GestStock dont le prix de référence (`externalPrice`) diffère
 * du prix de vente (`price`) de la boutique (lot 3, J11.2).
 */
export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);
    const products = await Product.find({
      shopId: authUser.userId,
      'external.source': 'geststock',
      externalPrice: { $exists: true },
      $expr: { $ne: ['$price', '$externalPrice'] },
    }).lean();
    return res.ok(products);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}
