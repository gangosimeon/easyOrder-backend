import { orderRepository, CreateOrderData } from '@/repositories/order.repository';
import { CreateOrderInput } from '@/validators/order.validator';
import { sendPushToUser } from '@/services/push-notification.service';

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

  const order = await orderRepository.create(createData);

  // Envoi push notification au propriétaire de la boutique (fire & forget)
  sendPushToUser(shopId, {
    title: 'Nouvelle commande reçue 🛒',
    body:  'Une nouvelle commande vient d\'être passée dans votre boutique.',
    url:   '/orders',
  }).catch(err => {
    console.error('[createOrder] Erreur envoi push notification:', err);
  });

  return order;
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
