import crypto from 'crypto';

export const OTP_TTL_MS = 5 * 60 * 1000;    // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;          // au-delà, le code est invalidé

export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

// Les OTP sont stockés hachés : une fuite de la base (ou d'une réponse API)
// ne doit pas suffire à réinitialiser un mot de passe.
export function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

export function otpMatches(otp: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashOtp(otp), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
