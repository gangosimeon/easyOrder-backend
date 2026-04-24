import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { getUserById, updateUserProfile } from '@/services/auth.service';
import { updateProfileSchema } from '@/validators/auth.validator';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const user = await getUserById(authUser.userId);
    return res.ok(user);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}

export async function PUT(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    const body = await req.json();
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const user = await updateUserProfile(authUser.userId, parsed.data);
    return res.ok(user);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}
