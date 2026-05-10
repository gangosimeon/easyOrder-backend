import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { getAdminShopStats } from '@/services/admin-shop.service';

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    requireAdmin(req);

    const stats = await getAdminShopStats(params.id);

    if (!stats) return res.notFound('Boutique introuvable');

    return res.ok(stats);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
