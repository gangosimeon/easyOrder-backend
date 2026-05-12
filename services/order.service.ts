import { orderRepository, CreateOrderData } from '@/repositories/order.repository';
import { CreateOrderInput } from '@/validators/order.validator';

export async function getOrdersByShop(shopId: string) {
  return orderRepository.findByShopId(shopId);
}

export async function getOrdersByShopPaginated(shopId: string | null, limit: number, skip: number) {
  return orderRepository.findByShopPaginated(shopId, limit, skip);
}

export async function countOrdersByShop(shopId: string) {
  return orderRepository.countByShop(shopId);
}

export async function countOrders() {
  return orderRepository.countAll();
}

export async function getOrderById(id: string, shopId: string) {
  const order = await orderRepository.findById(id);
  if (!order) throw Object.assign(new Error('Commande introuvable'), { status: 404 });
  if (order.shopId.toString() !== shopId) throw Object.assign(new Error('Accès non autorisé'), { status: 403 });
  return order;
}

export async function createOrder(shopId: string, data: CreateOrderInput) {
  const createData: CreateOrderData = {
    shopId,
    customerName: data.customerName,
    customerPhone: data.customerPhone,
    items: data.items.map(item => ({
      productId: item.productId,
      productName: item.productName,
      price: item.price,
      quantity: item.quantity,
      image: item.image,
      unit: item.unit,
    })),
    total: data.total,
    note: data.note,
    whatsappSent: data.whatsappSent,
  };
  return orderRepository.create(createData);
}

export async function updateOrderStatus(
  id: string,
  shopId: string,
  status: 'pending' | 'confirmed' | 'delivered' | 'cancelled'
) {
  console.log('Updating order status:', id, status);
  const order = await orderRepository.updateStatus(id, status);
  if (!order) throw Object.assign(new Error('Commande introuvable'), { status: 404 });
  if (order.shopId.toString() !== shopId) throw Object.assign(new Error('Accès non autorisé'), { status: 403 });
  return order;
}
