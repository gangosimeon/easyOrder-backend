import { z } from 'zod';

export const registerSchema = z.object({
  name:        z.string().min(2, 'Le nom doit avoir au moins 2 caractères').max(100),
  phone:       z.string().min(8, 'Numéro de téléphone invalide').max(20),
  password:    z.string().min(6, 'Le mot de passe doit avoir au moins 6 caractères'),
  description: z.string().max(500).default(''),
  logo:        z.string().default('🏪'),
  address:     z.string().max(200).default(''),
  coverColor:  z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur hexadécimale invalide').default('#a04343'),
});

export const loginSchema = z.object({
  phone:    z.string().min(1, 'Le numéro est requis'),
  password: z.string().min(1, 'Le mot de passe est requis'),
});

export const updateProfileSchema = z.object({
  name:        z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  logo:        z.string().optional(),
  address:     z.string().max(200).optional(),
  coverColor:  z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur hexadécimale invalide').optional(),
});

export type RegisterInput      = z.infer<typeof registerSchema>;
export type LoginInput         = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
