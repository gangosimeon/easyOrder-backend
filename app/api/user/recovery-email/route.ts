import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { recoveryEmailSchema } from '@/validators/user.validator';
import { requestRecoveryEmail } from '@/services/user.service';
import { requireAuthUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/tracking-guard';

export async function POST(req: Request) {
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);

    // Chaque appel envoie un email : limite pour protéger le quota d'envoi.
    if (await checkRateLimit(`recovery-email:user:${authUser.userId}`, 5, 60 * 60_000)) {
      return res.tooManyRequests();
    }

    // ── Valider body ───────────────────────────────────────────────────────────
    const body = await req.json();
    const parsed = recoveryEmailSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // ── Mettre l'email en attente et envoyer l'OTP ────────────────────────────
    await requestRecoveryEmail(authUser.userId, parsed.data.email, parsed.data.currentPassword);

    return res.ok({
      message: 'Un code de vérification a été envoyé à cette adresse.',
      email: parsed.data.email,
    });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 400) return res.badRequest(e.message || 'Erreur de validation');
    if (e.status === 404) return res.notFound(e.message || 'Ressource introuvable');
    if (e.status === 502) return res.serverError(e.message);
    console.error('[POST /api/user/recovery-email]', err);
    return res.serverError();
  }
}
