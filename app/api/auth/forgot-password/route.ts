import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { sendOtpEmail, isMailerConfigured } from '@/lib/mailer';
import { generateOtp, hashOtp, OTP_TTL_MS } from '@/lib/otp';
import { checkRateLimit, getClientIp } from '@/lib/tracking-guard';
import { forgotPasswordSchema } from '@/validators/user.validator';
import User from '@/models/user.model';

// Même réponse que l'email existe ou non : ne rien révéler sur les comptes.
const GENERIC_RESPONSE = {
  success: true,
  message: 'Si cet email est associé à un compte, un code de réinitialisation vient d\'y être envoyé.',
  expiresIn: OTP_TTL_MS / 1000,
};

export async function POST(req: Request) {
  try {
    await connectDB();

    const parsed = forgotPasswordSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: 'Email invalide' }, { status: 400 });
    }
    const { email } = parsed.data;

    // Chaque appel envoie un email : sans limite, on bombarde la victime et on
    // épuise le quota d'envoi pour tout le monde.
    if (await checkRateLimit(`forgot-password:ip:${getClientIp(req)}`, 10, 60 * 60_000) ||
        await checkRateLimit(`forgot-password:email:${email}`, 3, 60 * 60_000)) {
      return NextResponse.json({ success: false, message: 'Trop de tentatives, réessayez plus tard' }, { status: 429 });
    }

    // Seul un email *vérifié* peut servir à récupérer un compte.
    const user = await User.findOne({ recoveryEmail: email, recoveryEmailVerified: true }).select('_id');
    if (!user) return NextResponse.json(GENERIC_RESPONSE);

    const otp = generateOtp();
    await User.updateOne(
      { _id: user._id },
      { $set: { resetOtp: hashOtp(otp), resetOtpExpireAt: new Date(Date.now() + OTP_TTL_MS), resetOtpAttempts: 0 } }
    );

    if (!isMailerConfigured()) {
      console.error('[EMAIL ERROR] RESEND_API_KEY manquant');
    }

    // Envoi attendu (pas de fire-and-forget) : sur serverless, une promesse
    // laissée en suspens après la réponse peut être interrompue.
    const result = await sendOtpEmail(email, otp, 'forgot-password');
    if (!result.success) {
      console.error('[EMAIL ERROR] forgot-password: échec d\'envoi |', result.error);
    }

    return NextResponse.json(GENERIC_RESPONSE);
  } catch (err) {
    console.error('[POST /api/auth/forgot-password]', err);
    return NextResponse.json({ success: false, message: 'Erreur serveur' }, { status: 500 });
  }
}
