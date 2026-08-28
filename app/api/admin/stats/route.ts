import { connectDB } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';
import Product from '@/models/product.model';
import Order from '@/models/order.model';

export async function GET(req: Request) {
  try {
    await connectDB();
    await requireAdmin(req);

    const now          = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalShops, totalProducts, totalOrders, newShopsThisMonth] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      Product.countDocuments(),
      Order.countDocuments(),
      User.countDocuments({ role: 'user', createdAt: { $gte: startOfMonth } }),
    ]);

    return res.ok({ totalShops, totalProducts, totalOrders, newShopsThisMonth });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message?.includes('authentifié') || e.message?.includes('administrateurs')) {
      return res.forbidden(e.message);
    }
    return res.serverError();
  }
}
