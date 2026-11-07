import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await connectDB();
    await requireAdmin(req);

    const body = await req.json() as { geststockEnabled?: boolean };
    if (typeof body.geststockEnabled !== 'boolean') {
      return res.badRequest('geststockEnabled doit être un booléen');
    }

    const shop = await User.findByIdAndUpdate(
      params.id,
      { geststockEnabled: body.geststockEnabled },
      { new: true, select: '_id geststockEnabled' },
    ).lean();

    if (!shop) return res.notFound('Boutique introuvable');

    return res.ok({ id: String(shop._id), geststockEnabled: body.geststockEnabled });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
