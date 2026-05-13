import mongoose from 'mongoose';
import Order, { IOrder } from '../models/order.model';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CreateOrderData {
  shopId: string;
  customerName?: string;
  customerPhone?: string;
  items: {
    productId: string;
    productName: string;
    price: number;
    quantity: number;
    image: string;
    unit: string;
  }[];
  total: number;
  note?: string;
  whatsappSent: boolean;
}

// Proper type for MongoDB results
export type OrderDocument = IOrder & {
  _id: mongoose.Types.ObjectId;
  __v?: number;
  createdAt: Date;
  updatedAt: Date;
};

// ── Repository ─────────────────────────────────────────────────────────────

export class OrderRepository {
  private model = Order;

  /**
   * Crée une nouvelle commande.
   * Génère automatiquement l'ObjectId et les timestamps.
   */
  async create(data: CreateOrderData): Promise<OrderDocument> {
    try {
      const order = await this.model.create({
        ...data,
        shopId: new mongoose.Types.ObjectId(data.shopId),
        status: 'pending',
      });
      return order;
    } catch (error) {
      console.error('[OrderRepository.create] MongoDB error:', error);
      throw new Error('Erreur lors de la création de la commande');
    }
  }

  /**
   * Récupère une commande par son ID.
   */
  async findById(orderId: string): Promise<OrderDocument | null> {
    try {
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return null;
      }
      return await this.model.findById(orderId).exec();
    } catch (error) {
      console.error('[OrderRepository.findById] MongoDB error:', error);
      throw new Error('Erreur lors de la récupération de la commande');
    }
  }

  /**
   * Récupère toutes les commandes d'une boutique.
   */
  async findByShopId(shopId: string): Promise<OrderDocument[]> {
    try {
      if (!mongoose.Types.ObjectId.isValid(shopId)) {
        return [];
      }
      return await this.model
        .find({ shopId: new mongoose.Types.ObjectId(shopId) })
        .sort({ createdAt: -1 })
        .exec();
    } catch (error) {
      console.error('[OrderRepository.findByShopId] MongoDB error:', error);
      throw new Error('Erreur lors de la récupération des commandes');
    }
  }

  /**
   * Récupère toutes les commandes d'une boutique avec pagination.
   */
  async findByShopPaginated(shopId: string | null, limit: number, skip: number): Promise<OrderDocument[]> {
    try {
      const filter = shopId ? { shopId: new mongoose.Types.ObjectId(shopId) } : {};
      return await this.model
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .exec();
    } catch (error) {
      console.error('[OrderRepository.findByShopPaginated] MongoDB error:', error);
      throw new Error('Erreur lors de la récupération des commandes');
    }
  }

  /**
   * Compte les commandes d'une boutique.
   */
  async countByShop(shopId: string): Promise<number> {
    try {
      if (!mongoose.Types.ObjectId.isValid(shopId)) return 0;
      return await this.model.countDocuments({ shopId: new mongoose.Types.ObjectId(shopId) });
    } catch (error) {
      console.error('[OrderRepository.countByShop] MongoDB error:', error);
      throw new Error('Erreur lors du comptage des commandes');
    }
  }

  /**
   * Compte toutes les commandes (admin).
   */
  async countAll(): Promise<number> {
    try {
      return await this.model.countDocuments({});
    } catch (error) {
      console.error('[OrderRepository.countAll] MongoDB error:', error);
      throw new Error('Erreur lors du comptage des commandes');
    }
  }

  /**
   * Met à jour le statut d'une commande.
   */
  async updateStatus(orderId: string, status: 'pending' | 'confirmed' | 'delivered' | 'cancelled'): Promise<OrderDocument | null> {
    try {
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return null;
      }
      return await this.model
        .findByIdAndUpdate(orderId, { status }, { new: true })
        .exec();
    } catch (error) {
      console.error('[OrderRepository.updateStatus] MongoDB error:', error);
      throw new Error('Erreur lors de la mise à jour du statut');
    }
  }

  /**
   * Supprime une commande (soft delete ou hard delete selon besoin).
   */
  async delete(orderId: string): Promise<boolean> {
    try {
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return false;
      }
      const result = await this.model.deleteOne({ _id: orderId });
      return result.deletedCount > 0;
    } catch (error) {
      console.error('[OrderRepository.delete] MongoDB error:', error);
      throw new Error('Erreur lors de la suppression de la commande');
    }
  }
}

export const orderRepository = new OrderRepository();
