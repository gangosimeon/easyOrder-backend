import User, { IUser } from '@/models/user.model';
import { sendOtpEmail } from '@/lib/mailer';
import crypto from 'crypto';

// ── Générer OTP (6 chiffres) ───────────────────────────────────────────────
function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

// ── Définir l'email de récupération (temporaire, non vérifié) ───────────────
export async function setRecoveryEmail(userId: string, email: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('Utilisateur non trouvé');
    (error as any).status = 404;
    throw error;
  }

  // Vérifier si l'email est déjà utilisé par un autre utilisateur
  const existingUser = await User.findOne({ recoveryEmail: email, _id: { $ne: userId } });
  if (existingUser) {
    const error = new Error('Cet email est déjà utilisé');
    (error as any).status = 400;
    throw error;
  }

  user.recoveryEmail = email;
  user.recoveryEmailVerified = false;
  await user.save();
}

// ── Générer et sauvegarder OTP pour l'email de récupération ───────────────
export async function sendRecoveryEmailOtp(userId: string, email: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('Utilisateur non trouvé');
    (error as any).status = 404;
    throw error;
  }

  // Générer OTP
  const otp = generateOtp();
  const otpExpireAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Sauvegarder OTP
  user.recoveryOtp = otp;
  user.recoveryOtpExpireAt = otpExpireAt;
  await user.save();

  // Envoyer l'email avec l'OTP
  await sendOtpEmail(email, otp, 'recovery-email');
}

// ── Vérifier l'OTP pour l'email de récupération ─────────────────────────────
export async function verifyRecoveryEmailOtp(userId: string, email: string, otp: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('Utilisateur non trouvé');
    (error as any).status = 404;
    throw error;
  }

  // Vérifier que l'email correspond
  if (user.recoveryEmail !== email) {
    const error = new Error('Email ne correspond pas');
    (error as any).status = 400;
    throw error;
  }

  // Vérifier que l'OTP correspond
  if (user.recoveryOtp !== otp) {
    const error = new Error('OTP invalide');
    (error as any).status = 400;
    throw error;
  }

  // Vérifier l'expiration de l'OTP
  if (!user.recoveryOtpExpireAt || user.recoveryOtpExpireAt < new Date()) {
    const error = new Error('OTP expiré');
    (error as any).status = 400;
    throw error;
  }

  // Marquer l'email comme vérifié
  user.recoveryEmailVerified = true;
  user.recoveryOtp = undefined;
  user.recoveryOtpExpireAt = undefined;
  await user.save();
}
