import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { changePasswordSchema } from '@/validators/auth.validator';
import { changeUserPassword } from '@/services/auth.service';
import { requireAuthUser } from '@/lib/auth';

export async function POST(req: Request) {
  try {
    await connectDB();

    // requireAuthUser (et non un simple verifyToken) : un token révoqué par
    // déconnexion ou appartenant à un compte banni doit être refusé ici aussi.
    const authUser = await requireAuthUser(req);

    // ── Valider body ───────────────────────────────────────────────────────────
    const body = await req.json();
    const parsed = changePasswordSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // ── Changer le mot de passe ───────────────────────────────────────────────
    const result = await changeUserPassword(authUser.userId, parsed.data);

    return res.ok(result);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 400) return res.badRequest(e.message || 'Erreur de validation');
    if (e.status === 401) return res.unauthorized(e.message || 'Non autorisé');
    if (e.status === 404) return res.notFound(e.message || 'Ressource introuvable');
    console.error('[POST /api/auth/change-password]', err);
    return res.serverError();
  }
}
