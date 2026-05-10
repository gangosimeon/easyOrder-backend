import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { createAnnouncementSchema } from '@/validators/admin-announcement.validator';
import {
  listAnnouncements,
  createAnnouncement,
} from '@/services/admin-announcement.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    requireAdmin(req);

    const { searchParams } = new URL(req.url);
    const page  = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
    const limit = Math.min(50, parseInt(searchParams.get('limit') ?? '20'));

    const data = await listAnnouncements(page, limit);
    return res.ok(data);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}

export async function POST(req: Request) {
  try {
    await connectDB();
    const admin  = requireAdmin(req);
    const body   = await req.json();
    const parsed = createAnnouncementSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const doc = await createAnnouncement(parsed.data, admin.userId);
    return res.created(doc);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
