import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IOrderItem {
  productId: Types.ObjectId;
  productName: string;
  price: number;
  quantity: number;
  image: string;
  unit: string;
}

export interface IOrder extends Document {
  shopId: Types.ObjectId;
  customerName: string;
  customerPhone: string;
  items: IOrderItem[];
  total: number;
  status: 'pending' | 'confirmed' | 'delivered' | 'cancelled';
  whatsappSent: boolean;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    productId:   { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    price:       { type: Number, required: true },
    quantity:    { type: Number, required: true, min: 1 },
    image:       { type: String, default: '' },
    unit:        { type: String, default: 'pièce' },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    shopId:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerName:  { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },
    items:         { type: [orderItemSchema], required: true },
    total:         { type: Number, required: true, min: 0 },
    status:        {
      type: String,
      enum: ['pending', 'confirmed', 'delivered', 'cancelled'],
      default: 'pending',
    },
    whatsappSent:  { type: Boolean, default: false },
    note:          { type: String },
  },
  { timestamps: true }
);

orderSchema.index({ shopId: 1 });
orderSchema.index({ shopId: 1, status: 1 });

const Order: Model<IOrder> =
  mongoose.models.Order ?? mongoose.model<IOrder>('Order', orderSchema);

export default Order;
