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
    requireAdmin(req);

    const body = await req.json() as { isActive?: boolean };
    if (typeof body.isActive !== 'boolean') {
      return res.badRequest('isActive doit être un booléen');
    }

    const shop = await User.findByIdAndUpdate(
      params.id,
      { isActive: body.isActive },
      { new: true, select: '_id isActive' },
    ).lean();

    if (!shop) return res.notFound('Boutique introuvable');

    return res.ok({ id: String(shop._id), isActive: body.isActive });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
