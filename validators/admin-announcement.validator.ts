import { z } from 'zod';

export const createAnnouncementSchema = z.object({
  title:       z.string().min(1, 'Titre requis').max(200),
  content:     z.string().min(1, 'Contenu requis').max(2000),
  type:        z.enum(['info', 'warning', 'success', 'urgent']).default('info'),
  active:      z.boolean().default(true),
  targetShops: z.array(z.string()).default([]),
  expireAt:    z.string().nullable().optional(),
});

export const updateAnnouncementSchema = createAnnouncementSchema.partial();

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;
