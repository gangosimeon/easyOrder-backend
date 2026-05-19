import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { changePasswordSchema } from '@/validators/auth.validator';
import { changeUserPassword } from '@/services/auth.service';
import { verifyToken, JWTPayload } from '@/lib/auth';

export async function POST(req: Request) {
  try {
    await connectDB();

    // ── Vérifier JWT ─────────────────────────────────────────────────────────
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.unauthorized('Token manquant');
    }

    const token = authHeader.substring(7);
    const payload: JWTPayload = verifyToken(token);

    if (!payload.userId) {
      return res.unauthorized('Token invalide');
    }

    // ── Valider body ───────────────────────────────────────────────────────────
    const body = await req.json();
    const parsed = changePasswordSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // ── Changer le mot de passe ───────────────────────────────────────────────
    const result = await changeUserPassword(payload.userId, parsed.data);

    return res.ok(result);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 400) return res.badRequest(e.message || 'Erreur de validation');
    if (e.status === 401) return res.unauthorized(e.message || 'Non autorisé');
    if (e.status === 404) return res.notFound(e.message || 'Ressource introuvable');
    console.error('[POST /api/auth/change-password]', err);
    return res.serverError();
  }
}
