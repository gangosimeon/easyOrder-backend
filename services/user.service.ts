import bcrypt from 'bcryptjs';
import User from '@/models/user.model';
import { sendOtpEmail } from '@/lib/mailer';
import { generateOtp, hashOtp, otpMatches, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from '@/lib/otp';

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

// ── Demander un (nouvel) email de récupération ──────────────────────────────
// L'email de récupération permet de réinitialiser le mot de passe : le changer
// exige donc le mot de passe actuel (un token volé ne suffit pas), et le nouvel
// email reste « en attente » tant que l'OTP envoyé à cette adresse n'est pas
// validé. L'email vérifié actuel continue de fonctionner jusque-là.
export async function requestRecoveryEmail(userId: string, email: string, currentPassword: string): Promise<void> {
  const user = await User.findById(userId).select('+password');
  if (!user) throw httpError('Utilisateur non trouvé', 404);

  const isValid = await bcrypt.compare(currentPassword, user.password);
  if (!isValid) throw httpError('Mot de passe incorrect', 400);

  // Seul un email *vérifié* par un autre compte est considéré comme pris :
  // sinon n'importe qui pourrait bloquer l'adresse d'un tiers en la saisissant.
  const takenBy = await User.exists({ recoveryEmail: email, recoveryEmailVerified: true, _id: { $ne: userId } });
  if (takenBy) throw httpError('Cet email est déjà utilisé', 400);

  const otp = generateOtp();
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        pendingRecoveryEmail: email,
        recoveryOtp: hashOtp(otp),
        recoveryOtpExpireAt: new Date(Date.now() + OTP_TTL_MS),
        recoveryOtpAttempts: 0,
      },
    }
  );

  const result = await sendOtpEmail(email, otp, 'recovery-email');
  if (!result.success) throw httpError(result.error ?? 'Impossible d\'envoyer l\'email', 502);
}

// ── Vérifier l'OTP et activer l'email en attente ────────────────────────────
export async function verifyRecoveryEmailOtp(userId: string, email: string, otp: string): Promise<void> {
  const user = await User.findById(userId).select('+recoveryOtp +recoveryOtpExpireAt +recoveryOtpAttempts');
  if (!user) throw httpError('Utilisateur non trouvé', 404);

  if (!user.pendingRecoveryEmail || user.pendingRecoveryEmail !== email) {
    throw httpError('Aucune vérification en cours pour cet email', 400);
  }
  if (!user.recoveryOtp || !user.recoveryOtpExpireAt || user.recoveryOtpExpireAt < new Date()) {
    throw httpError('Code expiré. Demandez un nouveau code.', 400);
  }
  if (user.recoveryOtpAttempts >= OTP_MAX_ATTEMPTS) {
    throw httpError('Trop de tentatives. Demandez un nouveau code.', 400);
  }

  if (!otpMatches(otp, user.recoveryOtp)) {
    await User.updateOne({ _id: userId }, { $inc: { recoveryOtpAttempts: 1 } });
    throw httpError('Code invalide', 400);
  }

  await User.updateOne(
    { _id: userId },
    {
      $set: { recoveryEmail: email, recoveryEmailVerified: true },
      $unset: { pendingRecoveryEmail: 1, recoveryOtp: 1, recoveryOtpExpireAt: 1, recoveryOtpAttempts: 1 },
    }
  );
}
