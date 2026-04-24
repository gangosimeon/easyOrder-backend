import { z } from 'zod';

export const createAnnonceSchema = z.object({
  titre:     z.string().min(1, 'Le titre est requis').max(150),
  message:   z.string().min(1, 'Le message est requis').max(1000),
  type:      z.enum(['promo', 'info', 'alerte', 'evenement']),
  emoji:     z.string().default('📢'),
  dateDebut: z.string().datetime({ offset: true }).or(z.string().date()),
  dateFin:   z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  active:    z.boolean().default(true),
  epinglee:  z.boolean().default(false),
});

export const updateAnnonceSchema = createAnnonceSchema.partial();

export type CreateAnnonceInput = z.infer<typeof createAnnonceSchema>;
export type UpdateAnnonceInput = z.infer<typeof updateAnnonceSchema>;
