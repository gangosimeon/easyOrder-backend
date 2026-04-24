import { z } from 'zod';

export const createProductSchema = z.object({
  categoryId:    z.string().min(1, 'La catégorie est requise'),
  name:          z.string().min(1, 'Le nom est requis').max(200),
  price:         z.number({ required_error: 'Le prix est requis' }).min(0, 'Prix invalide'),
  originalPrice: z.number().min(0).optional(),
  promotion:     z.number().min(0).max(100).optional(),
  image:         z.string().default(''),
  description:   z.string().max(500).default(''),
  unit:          z.string().default('pièce'),
  stock:         z.number().min(0).default(0),
  inStock:       z.boolean().default(true),
});

export const updateProductSchema = createProductSchema.partial();

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
