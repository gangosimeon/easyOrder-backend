import { z } from 'zod';
import { isSafeExternalImageUrl } from '@/lib/safe-url';

const logoField = z.string().refine(isSafeExternalImageUrl, "URL d'image non autorisée");

export const registerSchema = z.object({
  name:        z.string().min(2, 'Le nom doit avoir au moins 2 caractères').max(100),
  phone:       z.string().min(5, 'Numéro de téléphone invalide').max(20).transform(p => p.replace(/\D/g, '')),
  countryCode: z.string().min(1).max(4).default('226').transform(c => c.replace(/\D/g, '')),
  password:    z.string().min(6, 'Le mot de passe doit avoir au moins 6 caractères'),
  description: z.string().max(500).default(''),
  logo:        logoField.default('🏪'),
  address:     z.string().max(200).default(''),
  coverColor:  z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur hexadécimale invalide').default('#a04343'),
});

export const loginSchema = z.object({
  phone:       z.string().min(1, 'Le numéro est requis').transform(p => p.replace(/\D/g, '')),
  password:    z.string().min(1, 'Le mot de passe est requis'),
  countryCode: z.string().optional().transform(c => c?.replace(/\D/g, '')),
});

export const updateProfileSchema = z.object({
  name:        z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  logo:        logoField.optional(),
  address:     z.string().max(200).optional(),
  coverColor:  z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur hexadécimale invalide').optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Le mot de passe actuel est requis'),
  newPassword: z.string().min(6, 'Le mot de passe doit avoir au moins 6 caractères'),
});

export type RegisterInput       = z.infer<typeof registerSchema>;
export type LoginInput          = z.infer<typeof loginSchema>;
export type UpdateProfileInput  = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
