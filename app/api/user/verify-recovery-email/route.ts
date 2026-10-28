import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { verifyRecoveryEmailSchema } from '@/validators/user.validator';
import { verifyRecoveryEmailOtp } from '@/services/user.service';
import { requireAuthUser } from '@/lib/auth';

export async function POST(req: Request) {
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);

    // ── Valider body ───────────────────────────────────────────────────────────
    const body = await req.json();
    const parsed = verifyRecoveryEmailSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // ── Vérifier OTP (tentatives limitées en base) et activer l'email ─────────
    await verifyRecoveryEmailOtp(authUser.userId, parsed.data.email, parsed.data.otp);

    return res.ok({
      message: 'Email de récupération vérifié avec succès',
      email: parsed.data.email
    });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 400) return res.badRequest(e.message || 'Erreur de validation');
    if (e.status === 404) return res.notFound(e.message || 'Ressource introuvable');
    console.error('[POST /api/user/verify-recovery-email]', err);
    return res.serverError();
  }
}
