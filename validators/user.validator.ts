import { z } from 'zod';

const emailField = z.string().trim().toLowerCase().email('Email invalide').max(254);
const otpField   = z.string().trim().regex(/^\d{6}$/, 'Le code doit contenir 6 chiffres');

export const recoveryEmailSchema = z.object({
  email: emailField,
  currentPassword: z.string().min(1, 'Le mot de passe actuel est requis'),
});

export const verifyRecoveryEmailSchema = z.object({
  email: emailField,
  otp: otpField,
});

export const forgotPasswordSchema = z.object({
  email: emailField,
});

export const verifyResetOtpSchema = z.object({
  email: emailField,
  otp: otpField,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token requis'),
  newPassword: z.string()
    .min(6, 'Le mot de passe doit avoir au moins 6 caractères')
    .max(128, 'Le mot de passe est trop long'),
});
