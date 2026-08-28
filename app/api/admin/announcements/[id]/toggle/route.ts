import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { toggleAnnouncement } from '@/services/admin-announcement.service';

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    await requireAdmin(req);

    const doc = await toggleAnnouncement(params.id);
    return res.ok(doc);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 404) return res.notFound(e.message);
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
