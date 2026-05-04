import { Types } from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { getShopVisitStats } from '@/services/shop-visit.service';

export async function GET(
  req: Request,
  { params }: { params: { shopId: string } }
) {
  try {
    await connectDB();

    const authUser = requireAuthUser(req);

    if (authUser.userId !== params.shopId) {
      return res.forbidden();
    }

    if (!Types.ObjectId.isValid(params.shopId)) {
      return res.badRequest('shopId invalide');
    }

    const stats = await getShopVisitStats(params.shopId);
    return res.ok(stats);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}
