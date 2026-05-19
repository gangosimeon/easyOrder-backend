import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { recoveryEmailSchema } from '@/validators/user.validator';
import { setRecoveryEmail, sendRecoveryEmailOtp } from '@/services/user.service';
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
    const parsed = recoveryEmailSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // ── Sauvegarder email temporaire et envoyer OTP ───────────────────────────
    const result = await setRecoveryEmail(payload.userId, parsed.data.email);
    
    // Générer et envoyer OTP
    await sendRecoveryEmailOtp(payload.userId, parsed.data.email);

    return res.ok({ 
      message: 'Email de récupération ajouté. Vérifiez votre boîte mail pour le code OTP.',
      email: parsed.data.email
    });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 400) return res.badRequest(e.message || 'Erreur de validation');
    if (e.status === 401) return res.unauthorized(e.message || 'Non autorisé');
    if (e.status === 404) return res.notFound(e.message || 'Ressource introuvable');
    console.error('[POST /api/user/recovery-email]', err);
    return res.serverError();
  }
}
