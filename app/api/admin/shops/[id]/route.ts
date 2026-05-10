import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { getAdminShopById } from '@/services/admin-shop.service';

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    requireAdmin(req);

    const baseUrl = new URL(req.url).origin;
    const shop    = await getAdminShopById(params.id, baseUrl);

    if (!shop) return res.notFound('Boutique introuvable');

    return res.ok(shop);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
