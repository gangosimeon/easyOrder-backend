import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IShopVisit extends Document {
  shopId:    Types.ObjectId;
  visitorId: string;
  ipAddress: string;
  userAgent: string;
  source?:   string;
  visitedAt: Date;
}

const shopVisitSchema = new Schema<IShopVisit>(
  {
    shopId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
    visitorId: { type: String, required: true },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true },
    source:    { type: String },
    visitedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false }
);

shopVisitSchema.index({ shopId: 1 });
shopVisitSchema.index({ shopId: 1, visitedAt: -1 });
shopVisitSchema.index({ shopId: 1, visitorId: 1 });

const ShopVisit: Model<IShopVisit> =
  mongoose.models.ShopVisit ?? mongoose.model<IShopVisit>('ShopVisit', shopVisitSchema);

export default ShopVisit;
