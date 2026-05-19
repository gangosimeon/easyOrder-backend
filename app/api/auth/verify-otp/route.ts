import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { signResetToken } from '@/lib/auth';
import User from '@/models/user.model';

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const email = body?.email?.trim().toLowerCase();
    const otp = body?.otp?.trim();

    if (!email || !otp) {
      return NextResponse.json({ success: false, message: 'Email et code requis' }, { status: 400 });
    }

    const user = await User.findOne({ recoveryEmail: email });

    // Réponse générique pour la sécurité
    if (!user || !user.resetOtp || !user.resetOtpExpireAt) {
      return NextResponse.json({ success: false, message: 'Code invalide ou expiré' }, { status: 400 });
    }

    // Vérifier expiration
    if (user.resetOtpExpireAt < new Date()) {
      user.resetOtp = undefined;
      user.resetOtpExpireAt = undefined;
      await user.save();
      return NextResponse.json({ success: false, message: 'Code expiré. Demandez un nouveau code.' }, { status: 400 });
    }

    // Vérifier OTP
    if (user.resetOtp !== otp) {
      return NextResponse.json({ success: false, message: 'Code invalide' }, { status: 400 });
    }

    // OTP valide — effacer l'OTP et générer reset token (15 min)
    user.resetOtp = undefined;
    user.resetOtpExpireAt = undefined;
    await user.save();

    const resetToken = signResetToken(user._id.toString());

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
