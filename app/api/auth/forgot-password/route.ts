import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { sendOtpEmail } from '@/lib/mailer';
import User from '@/models/user.model';
import crypto from 'crypto';

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const email = body?.email?.trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, message: 'Email invalide' }, { status: 400 });
    }

    // Chercher l'utilisateur par son email de récupération
    const user = await User.findOne({ recoveryEmail: email });

    // Réponse générique pour ne pas exposer si l'email existe
    if (!user) {
      return NextResponse.json({
        success: true,
        message: 'Si cet email est enregistré, vous recevrez un code de réinitialisation.',
        expiresIn: 300,
      });
    }

    // Générer OTP
    const otp = generateOtp();
    const otpExpireAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Sauvegarder OTP (champs séparés des OTP de vérification email)
    user.resetOtp = otp;
    user.resetOtpExpireAt = otpExpireAt;
    await user.save();

    // Envoyer l'email (sans bloquer la réponse si erreur)
    sendOtpEmail(email, otp, 'forgot-password').catch(err => {
      console.error('[EMAIL ERROR] forgot-password:', err?.message);
    });

    return NextResponse.json({
      success: true,
      message: 'Code de réinitialisation envoyé sur votre email de récupération.',
      expiresIn: 300,
    });
  } catch (err) {
    console.error('[POST /api/auth/forgot-password]', err);
    return NextResponse.json({ success: false, message: 'Erreur serveur' }, { status: 500 });
  }
}
