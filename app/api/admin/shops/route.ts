import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { listShopsQuerySchema } from '@/validators/admin.validator';
import { listAdminShops } from '@/services/admin-shop.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    requireAdmin(req);

    const { searchParams, origin } = new URL(req.url);
    const parsed = listShopsQuerySchema.safeParse(Object.fromEntries(searchParams));

    if (!parsed.success) {
      return res.badRequest('Paramètres invalides', parsed.error.flatten().fieldErrors);
    }

    const { search, page, limit, sortField, sortDir, status, dateFrom, dateTo } = parsed.data;

    const result = await listAdminShops(
      { search, status, dateFrom, dateTo },
      { sortField, sortDir },
      { page, limit },
      origin,
    );

    return res.ok(result);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
