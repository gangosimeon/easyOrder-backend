import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { updateAnnonceSchema } from '@/validators/annonce.validator';
import {
  getAnnonceById,
  updateAnnonce,
  deleteAnnonce,
} from '@/services/annonce.service';

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const annonce = await getAnnonceById(params.id, authUser.userId);
    return res.ok(annonce);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    const body = await req.json();
    const parsed = updateAnnonceSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const annonce = await updateAnnonce(params.id, authUser.userId, parsed.data);
    return res.ok(annonce);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    await deleteAnnonce(params.id, authUser.userId);
    return res.ok({ message: 'Annonce supprimée' });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}
