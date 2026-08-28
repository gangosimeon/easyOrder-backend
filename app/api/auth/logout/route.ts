import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { requireAuthUser } from '@/lib/auth';
import { logoutUser } from '@/services/auth.service';

export async function POST(req: Request) {
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);
    await logoutUser(authUser.userId);
    return res.ok({ message: 'Déconnecté' });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    console.error('[POST /api/auth/logout]', err);
    return res.serverError();
  }
}
