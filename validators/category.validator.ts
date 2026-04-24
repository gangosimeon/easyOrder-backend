import { z } from 'zod';

export const createCategorySchema = z.object({
  name:        z.string().min(1, 'Le nom est requis').max(100),
  icon:        z.string().default('inventory_2'),
  color:       z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur invalide').default('#FF6B35'),
  description: z.string().max(300).default(''),
});

export const updateCategorySchema = createCategorySchema.partial();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
