import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import { Logger } from '@/lib/logger';
import * as res from '@/lib/api-response';
import { updateOrderStatusSchema } from '@/validators/order.validator';
import { updateOrderStatus } from '@/services/order.service';

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    // Parse and validate request body
    const body = await req.json();
    const parsed = updateOrderStatusSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const { id } = params;
    const { status } = parsed.data;

    // Update order status
    const updatedOrder = await updateOrderStatus(id, authUser.userId, status);

    Logger.access('Order status updated', {
      userId: authUser.userId,
      role: authUser.role,
      method: 'PATCH',
      route: `/api/orders/${id}`,
    });

    // Convert MongoDB ObjectId to string for frontend
    const responseOrder = {
      ...updatedOrder.toObject(),
      _id: updatedOrder._id.toString(),
      shopId: updatedOrder.shopId.toString(),
    };

    return res.ok(responseOrder);
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number };
    if (e.message === 'Non authentifié') {
      Logger.warn('Unauthorized status update attempt', { method: 'PATCH', route: '/api/orders/[id]' });
      return res.unauthorized();
    }
    if (e.status === 403) {
      Logger.warn('Forbidden status update attempt', { method: 'PATCH', route: '/api/orders/[id]' });
      return res.forbidden('Accès non autorisé');
    }
    if (e.status === 404) {
      return res.notFound('Commande introuvable');
    }
    Logger.error('Failed to update order status', { method: 'PATCH', route: '/api/orders/[id]' });
    console.error('[PATCH /api/orders/[id]]', err);
    return res.serverError();
  }
}
