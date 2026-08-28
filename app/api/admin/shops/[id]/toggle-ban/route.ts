import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    await requireAdmin(req);

    const body = await req.json() as { banned?: boolean };
    if (typeof body.banned !== 'boolean') {
      return res.badRequest('banned doit être un booléen');
    }

    const shop = await User.findByIdAndUpdate(
      params.id,
      { banned: body.banned },
      { new: true, select: '_id banned' },
    ).lean();

    if (!shop) return res.notFound('Boutique introuvable');

    return res.ok({ id: String(shop._id), banned: body.banned });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
