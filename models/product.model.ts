import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IProduct extends Document {
  shopId: Types.ObjectId;
  categoryId: Types.ObjectId;
  name: string;
  price: number;
  originalPrice?: number;
  promotion?: number;
  image: string;
  description: string;
  unit: string;
  stock: number;
  inStock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    shopId:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
    categoryId:    { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    name:          { type: String, required: true, trim: true },
    price:         { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, min: 0 },
    promotion:     { type: Number, min: 0, max: 100 },
    image:         { type: String, default: '' },
    description:   { type: String, default: '' },
    unit:          { type: String, default: 'pièce' },
    stock:         { type: Number, default: 0, min: 0 },
    inStock:       { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ shopId: 1 });
productSchema.index({ categoryId: 1 });
productSchema.index({ shopId: 1, categoryId: 1 });

const Product: Model<IProduct> =
  mongoose.models.Product ?? mongoose.model<IProduct>('Product', productSchema);

export default Product;
