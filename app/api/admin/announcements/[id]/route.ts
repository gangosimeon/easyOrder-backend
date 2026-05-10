import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { updateAnnouncementSchema } from '@/validators/admin-announcement.validator';
import {
  getAnnouncementById,
  updateAnnouncement,
  deleteAnnouncement,
} from '@/services/admin-announcement.service';

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    requireAdmin(req);

    const doc = await getAnnouncementById(params.id);
    if (!doc) return res.notFound('Annonce introuvable');

    return res.ok(doc);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    requireAdmin(req);

    const body   = await req.json();
    const parsed = updateAnnouncementSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const doc = await updateAnnouncement(params.id, parsed.data);
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

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    requireAdmin(req);

    await deleteAnnouncement(params.id);
    return res.ok({ deleted: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 404) return res.notFound(e.message);
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
