import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { toggleAnnonceActive } from '@/services/annonce.service';

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);
    const annonce = await toggleAnnonceActive(params.id, authUser.userId);
    return res.ok(annonce);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}
