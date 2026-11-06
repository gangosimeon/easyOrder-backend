import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';
import GeststockLink from '@/models/geststock-link.model';
import { GeststockLinkRepository } from '@/repositories/geststock-link.repository';

const linkRepository = new GeststockLinkRepository();

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    // J12.1 : révoquer la liaison GestStock active si la boutique est bannie
    if (body.banned) {
      const link = await GeststockLink.findOne({ shopId: shop._id, status: 'ACTIVE' }).lean();
      if (link) {
        await linkRepository.revoke(params.id, link.linkId, 'Boutique bannie', new Date());
      }
    }

    return res.ok({ id: String(shop._id), banned: body.banned });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
