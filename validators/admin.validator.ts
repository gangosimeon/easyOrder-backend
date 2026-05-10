import { z } from 'zod';

export const listShopsQuerySchema = z.object({
  search:    z.string().optional(),
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
  sortField: z
    .enum(['name', 'createdAt', 'slug', 'phone', 'productCount', 'status'])
    .default('createdAt'),
  sortDir:   z.enum(['asc', 'desc']).default('desc'),
  status:    z.enum(['active', 'inactive', 'all']).default('all'),
  dateFrom:  z.string().optional(),
  dateTo:    z.string().optional(),
});

export type ListShopsQuery = z.infer<typeof listShopsQuerySchema>;
