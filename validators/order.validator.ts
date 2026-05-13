import { z } from 'zod';

const orderItemSchema = z.object({
  productId:   z.string().min(1, 'productId requis'),
  productName: z.string().optional(),
  name:        z.string().optional(),
  price:       z.number().min(0),
  quantity:    z.number().min(1),
  image:       z.string().default(''),
  unit:        z.string().default('pièce'),
}).transform(({ name, productName, ...rest }) => ({
  ...rest,
  productName: productName ?? name ?? '',
}));

export const createOrderSchema = z.object({
  customerName:  z.string().max(100).optional(),
  customerPhone: z.string().min(8, 'Numéro invalide').max(20).optional().transform(phone => phone ? phone.replace(/\+/g, '') : ''),
  items:         z.array(orderItemSchema).min(1, 'Au moins un article requis'),
  total:         z.number().min(0),
  note:          z.string().max(500).optional(),
  whatsappSent:  z.boolean().default(false),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'delivered', 'cancelled']),
});

export type CreateOrderInput      = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
