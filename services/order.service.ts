import Order from '@/models/order.model';
import { CreateOrderInput } from '@/validators/order.validator';

export async function getOrdersByShop(shopId: string) {
  return Order.find({ shopId }).sort({ createdAt: -1 }).lean();
}

export async function getOrderById(id: string, shopId: string) {
  const order = await Order.findOne({ _id: id, shopId }).lean();
  if (!order) throw Object.assign(new Error('Commande introuvable'), { status: 404 });
  return order;
}

export async function createOrder(shopId: string, data: CreateOrderInput) {
  return Order.create({ ...data, shopId });
}

export async function updateOrderStatus(
  id: string,
  shopId: string,
  status: 'pending' | 'confirmed' | 'delivered' | 'cancelled'
) {
  const order = await Order.findOneAndUpdate(
    { _id: id, shopId },
    { $set: { status } },
    { new: true }
  );
  if (!order) throw Object.assign(new Error('Commande introuvable'), { status: 404 });
  return order;
}
