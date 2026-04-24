import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { createOrderSchema } from '@/validators/order.validator';
import { getOrdersByShop, createOrder } from '@/services/order.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const orders = await getOrdersByShop(authUser.userId);
    return res.ok(orders);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const { searchParams } = new URL(req.url);
    const shopSlug = searchParams.get('shopSlug');

    if (!shopSlug) {
      return res.badRequest('Le paramètre shopSlug est requis');
    }

    const User = (await import('@/models/user.model')).default;
    const shop = await User.findOne({ slug: shopSlug }).lean();
    if (!shop) return res.notFound('Boutique introuvable');

    const order = await createOrder(shop._id.toString(), parsed.data);
    return res.created(order);
  } catch {
    return res.serverError();
  }
}
