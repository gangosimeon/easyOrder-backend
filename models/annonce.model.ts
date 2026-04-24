import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AnnonceType = 'promo' | 'info' | 'alerte' | 'evenement';

export interface IAnnonce extends Document {
  shopId: Types.ObjectId;
  titre: string;
  message: string;
  type: AnnonceType;
  emoji: string;
  dateDebut: Date;
  dateFin?: Date;
  active: boolean;
  epinglee: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const annonceSchema = new Schema<IAnnonce>(
  {
    shopId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
    titre:     { type: String, required: true, trim: true },
    message:   { type: String, required: true },
    type:      { type: String, enum: ['promo', 'info', 'alerte', 'evenement'], required: true },
    emoji:     { type: String, default: '📢' },
    dateDebut: { type: Date, required: true },
    dateFin:   { type: Date },
    active:    { type: Boolean, default: true },
    epinglee:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

annonceSchema.index({ shopId: 1 });
annonceSchema.index({ shopId: 1, active: 1 });

const Annonce: Model<IAnnonce> =
  mongoose.models.Annonce ?? mongoose.model<IAnnonce>('Annonce', annonceSchema);

export default Annonce;
