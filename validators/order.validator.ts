import { z } from 'zod';

const MAX_ITEMS    = 50;
const MAX_QUANTITY = 999;

const orderItemSchema = z.object({
  productId:   z.string().min(1, 'productId requis'),
  productName: z.string().max(200).optional(),
  name:        z.string().max(200).optional(),
  price:       z.number().min(0),
  quantity:    z.number().int('Quantité invalide').min(1).max(MAX_QUANTITY),
  image:       z.string().max(2000).default(''),
  unit:        z.string().max(50).default('pièce'),
}).transform(({ name, productName, ...rest }) => ({
  ...rest,
  productName: productName ?? name ?? '',
}));

export const createOrderSchema = z.object({
  customerName:  z.string().trim().min(2, 'Nom requis').max(100),
  // Numéro international en chiffres uniquement (indicatif inclus), comme le
  // produit le formulaire : tout autre format trahit un appel direct à l'API.
  customerPhone: z.string()
    .transform(phone => phone.replace(/[\s+]/g, ''))
    .pipe(z.string().regex(/^\d{8,15}$/, 'Numéro de téléphone invalide')),
  items:         z.array(orderItemSchema).min(1, 'Au moins un article requis').max(MAX_ITEMS, 'Trop d\'articles'),
  total:         z.number().min(0),
  note:          z.string().max(500).optional(),
  whatsappSent:  z.boolean().default(false),
  // Champ piège invisible pour un humain : un robot qui remplit tout le formulaire le renseigne.
  website:       z.string().max(0, 'Requête refusée').optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'delivered', 'cancelled']),
});

export type CreateOrderInput      = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
