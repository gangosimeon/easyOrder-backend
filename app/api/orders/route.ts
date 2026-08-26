import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import { Logger } from '@/lib/logger';
import * as res from '@/lib/api-response';
import { createOrderSchema, updateOrderStatusSchema } from '@/validators/order.validator';
import { getOrdersByShopPaginated, countOrders, countOrdersByShop, createOrder, updateOrderStatus } from '@/services/order.service';
import User from '@/models/user.model';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    // Pagination params
    const { searchParams } = new URL(req.url, 'http://localhost');
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    // Admin: voit toutes les commandes
    // User: voit uniquement ses commandes (shopId === userId)
    let orders;
    let total;

    if (authUser.role === 'admin') {
      // Admin: pas de filtrage shopId
      const [ordersData, count] = await Promise.all([
        getOrdersByShopPaginated(null, limit, skip),
        countOrders(),
      ]);
      orders = ordersData;
      total = count;
      Logger.access('Orders fetched (admin view)', {
        userId: authUser.userId,
        role: authUser.role,
        method: 'GET',
        route: '/api/orders',
      });
    } else {
      // User: filtrage strict par shopId (userId === shopId)
      const shopId = authUser.userId;
      const [ordersData, count] = await Promise.all([
        getOrdersByShopPaginated(shopId, limit, skip),
        countOrdersByShop(shopId),
      ]);
      orders = ordersData;
      total = count;
      Logger.access('Orders fetched (shop view)', {
        userId: authUser.userId,
        role: authUser.role,
        shopId,
        method: 'GET',
        route: '/api/orders',
      });
    }

    // Convert MongoDB ObjectId to string for frontend
    orders = orders.map(order => {
      const obj = order.toObject({ virtuals: false });
      return {
        ...obj,
        _id: order._id.toString(),
        shopId: order.shopId.toString(),
      };
    });

    return res.ok({
      data: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') {
      Logger.warn('Unauthorized access attempt', { method: 'GET', route: '/api/orders' });
      return res.unauthorized();
    }
    Logger.error('Failed to fetch orders', { method: 'GET', route: '/api/orders' });
    console.error('[GET /api/orders]', err);
    return res.serverError();
  }
}

export async function POST(req: Request) {
  try {
    await connectDB();

    // 1. Validation Zod
    const body = await req.json();
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // 2. Récupérer shopSlug query param
    const { searchParams } = new URL(req.url, 'http://localhost');
    const shopSlug = searchParams.get('shopSlug');
    if (!shopSlug) {
      return res.badRequest('Le paramètre shopSlug est requis');
    }

    // 3. Trouver la boutique par slug
    const shop = await User.findOne({ slug: shopSlug }).lean();
    if (!shop) return res.notFound('Boutique introuvable');

    // 4. Créer la commande via service (repository)
    const order = await createOrder(shop._id.toString(), parsed.data);
    console.log(`[POST /api/orders] Order created: ${order._id} for shop ${shopSlug}`);

    return res.created(order);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 400) return res.badRequest(e.message ?? 'Erreur');
    console.error('[POST /api/orders]', err);
    return res.serverError();
  }
}
