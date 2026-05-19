import { z } from 'zod';

export const recoveryEmailSchema = z.object({
  email: z.string().email('Email invalide'),
});

export const verifyRecoveryEmailSchema = z.object({
  email: z.string().email('Email invalide'),
  otp: z.string().length(6, 'OTP doit contenir 6 chiffres'),
});
