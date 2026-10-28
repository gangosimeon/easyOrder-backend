import mongoose, { Model, Schema } from 'mongoose';

// Compteur de requêtes par clé et par fenêtre de temps, partagé entre toutes
// les instances (Vercel serverless, conteneurs multiples). MongoDB supprime
// chaque document à `expiresAt` grâce à l'index TTL.
export interface IRateLimit {
  _id: string;       // `${clé}:${début de fenêtre}`
  count: number;
  expiresAt: Date;
}

const rateLimitSchema = new Schema<IRateLimit>(
  {
    _id:       { type: String, required: true },
    count:     { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimit: Model<IRateLimit> =
  mongoose.models.RateLimit ?? mongoose.model<IRateLimit>('RateLimit', rateLimitSchema);

export default RateLimit;
