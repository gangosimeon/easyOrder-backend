import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { signResetToken } from '@/lib/auth';
import { otpMatches, OTP_MAX_ATTEMPTS } from '@/lib/otp';
import { checkRateLimit, getClientIp } from '@/lib/tracking-guard';
import { verifyResetOtpSchema } from '@/validators/user.validator';
import User from '@/models/user.model';

const INVALID = { success: false, message: 'Code invalide ou expiré' };

export async function POST(req: Request) {
  try {
    await connectDB();

    const parsed = verifyResetOtpSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: 'Email et code à 6 chiffres requis' }, { status: 400 });
    }
    const { email, otp } = parsed.data;

    // Un OTP à 6 chiffres (900k combinaisons) doit être verrouillé bien avant
    // d'être épuisable par force brute pendant sa fenêtre de validité (5 min).
    if (await checkRateLimit(`verify-otp:ip:${getClientIp(req)}`, 20, 10 * 60_000)) {
      return NextResponse.json({ success: false, message: 'Trop de tentatives, réessayez plus tard' }, { status: 429 });
    }

    const user = await User.findOne({ recoveryEmail: email, recoveryEmailVerified: true })
      .select('+resetOtp +resetOtpExpireAt +resetOtpAttempts tokenVersion');

    if (!user || !user.resetOtp || !user.resetOtpExpireAt || user.resetOtpExpireAt < new Date()) {
      return NextResponse.json(INVALID, { status: 400 });
    }

    // Compteur en base : le code est grillé après OTP_MAX_ATTEMPTS échecs,
    // quelle que soit l'IP ou l'instance qui reçoit les tentatives.
    if (user.resetOtpAttempts >= OTP_MAX_ATTEMPTS) {
      return NextResponse.json({ success: false, message: 'Trop de tentatives. Demandez un nouveau code.' }, { status: 400 });
    }

    if (!otpMatches(otp, user.resetOtp)) {
      await User.updateOne({ _id: user._id }, { $inc: { resetOtpAttempts: 1 } });
      return NextResponse.json(INVALID, { status: 400 });
    }

    // OTP valide — l'effacer et émettre un reset token (15 min, usage unique)
    await User.updateOne(
      { _id: user._id },
      { $unset: { resetOtp: 1, resetOtpExpireAt: 1, resetOtpAttempts: 1 } }
    );

    const resetToken = signResetToken(user._id.toString(), user.tokenVersion);

    return NextResponse.json({
      success: true,
      message: 'Code vérifié avec succès',
      token: resetToken,
    });
  } catch (err) {
    console.error('[POST /api/auth/verify-otp]', err);
    return NextResponse.json({ success: false, message: 'Erreur serveur' }, { status: 500 });
  }
}
