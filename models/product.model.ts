import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/** Identifiant externe posé par la synchronisation GestStock (J6) — jamais écrit par l'API boutique. */
export interface IExternalRef {
  source: string;
  id: string;
  version: number;
}

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
  /** Posé par la synchronisation GestStock ; absent sur les produits boutique purs. */
  external?: IExternalRef;
  /** Prix de référence GestStock (lot 3, J7b) ; jamais écrit par l'API boutique. */
  externalPrice?: number;
  /** Empreinte SHA-256 de l'image GestStock (lot 3, J9) : posée par les événements PRODUCT_IMAGE et l'instantané. */
  imageSha256?: string | null;
  /** Génération de l'image GestStock (lot 3, J9) : idempotence des événements PRODUCT_IMAGE. */
  imageVersion?: number | null;
  /** ETag reçu lors du dernier téléchargement réussi (lot 3, J9) : envoyé en If-None-Match. */
  imageETag?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const externalRefSchema = new Schema<IExternalRef>(
  {
    source:  { type: String, required: true },
    id:      { type: String, required: true },
    version: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const productSchema = new Schema<IProduct>(
  {
    shopId:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
    categoryId:    { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    name:          { type: String, default: '', trim: true },
    price:         { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, min: 0 },
    promotion:     { type: Number, min: 0, max: 100 },
    image:         { type: String, default: '' },
    description:   { type: String, default: '' },
    unit:          { type: String, default: '' },
    stock:         { type: Number, default: 0, min: 0 },
    inStock:       { type: Boolean, default: true },
    external:      { type: externalRefSchema },
    externalPrice: { type: Number, min: 0 },
    imageSha256:   { type: String, default: null },
    imageVersion:  { type: Number, min: 0, default: null },
    imageETag:     { type: String, default: null },
  },
  { timestamps: true }
);

productSchema.index({ shopId: 1 });
productSchema.index({ categoryId: 1 });
productSchema.index({ shopId: 1, categoryId: 1 });
// Au plus une association par (boutique, source, identifiant externe) — partiel : seulement si external.source existe.
productSchema.index(
  { shopId: 1, 'external.source': 1, 'external.id': 1 },
  { unique: true, partialFilterExpression: { 'external.source': { $exists: true } } }
);

const Product: Model<IProduct> =
  mongoose.models.Product ?? mongoose.model<IProduct>('Product', productSchema);

export default Product;
