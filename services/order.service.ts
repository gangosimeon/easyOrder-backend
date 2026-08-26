import mongoose from 'mongoose';
import { orderRepository, CreateOrderData } from '@/repositories/order.repository';
import { CreateOrderInput } from '@/validators/order.validator';
import { sendPushToUser } from '@/services/push-notification.service';
import Product from '@/models/product.model';

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
  // Le prix/total ne doit jamais provenir du client : on recharge chaque
  // produit depuis la base et on recalcule tout côté serveur.
  const validIds = data.items
    .map(item => item.productId)
    .filter(id => mongoose.Types.ObjectId.isValid(id));

  const products = await Product.find({ _id: { $in: validIds }, shopId }).lean();
  const productById = new Map(products.map(p => [p._id.toString(), p]));

  const items = data.items.map(item => {
    const product = productById.get(item.productId);
    if (!product) {
      throw Object.assign(
        new Error('Un ou plusieurs produits sont introuvables ou n\'appartiennent pas à cette boutique'),
        { status: 400 }
      );
    }
    return {
      productId: item.productId,
      productName: product.name,
      price: product.price,
      quantity: item.quantity,
      image: product.image,
      unit: product.unit,
    };
  });

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const createData: CreateOrderData = {
    shopId,
    customerName: data.customerName,
    customerPhone: data.customerPhone,
    items,
    total,
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
  // Le filtre shopId fait partie de la requête Mongo elle-même (findOneAndUpdate
  // atomique) : impossible d'écrire sur la commande d'une autre boutique, et on
  // ne distingue pas "introuvable" de "pas la vôtre" pour ne rien révéler à un
  // appelant non autorisé sur l'existence des commandes d'autrui.
  const order = await orderRepository.updateStatus(id, shopId, status);
  if (!order) throw Object.assign(new Error('Commande introuvable'), { status: 404 });
  return order;
}
