import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface ICategory extends Document {
  shopId: Types.ObjectId;
  name: string;
  icon: string;
  color: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    shopId:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name:        { type: String, required: true, trim: true },
    icon:        { type: String, default: 'inventory_2' },
    color:       { type: String, default: '#FF6B35' },
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

categorySchema.index({ shopId: 1 });

const Category: Model<ICategory> =
  mongoose.models.Category ?? mongoose.model<ICategory>('Category', categorySchema);

export default Category;
