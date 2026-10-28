import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  slug: string;
  phone: string;
  countryCode?: string;
  fullPhone?: string;
  password: string;
  description: string;
  logo: string;
  address: string;
  coverColor: string;
  role: 'admin' | 'user';
  isActive: boolean;
  /** Suspension par un administrateur — distinct de isActive (visibilité publique / approbation). */
  banned: boolean;
  /** Incrémentée à la déconnexion et au changement de mot de passe pour révoquer instantanément tous les access tokens déjà émis. */
  tokenVersion: number;
  refreshTokens: { tokenHash: string; expiresAt: Date }[];
  recoveryEmail?: string;
  recoveryEmailVerified: boolean;
  /** Email en attente de vérification : ne remplace `recoveryEmail` qu'après validation de l'OTP. */
  pendingRecoveryEmail?: string;
  /** Hash SHA-256 de l'OTP (jamais le code en clair). */
  recoveryOtp?: string;
  recoveryOtpExpireAt?: Date;
  recoveryOtpAttempts: number;
  resetOtp?: string;
  resetOtpExpireAt?: Date;
  resetOtpAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name:        { type: String, required: true, trim: true },
    slug:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone:       { type: String, required: true, unique: true, trim: true },
    countryCode: { type: String, trim: true },
    fullPhone:   { type: String, trim: true, sparse: true },
    password:    { type: String, required: true, select: false },
    description: { type: String, default: '' },
    logo:        { type: String, default: '🏪' },
    address:     { type: String, default: '' },
    coverColor:  { type: String, default: '#a04343' },
    role:        { type: String, enum: ['admin', 'user'], default: 'user' },
    isActive:    { type: Boolean, default: true },
    banned:      { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    refreshTokens: {
      type: [{
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        _id: false,
      }],
      default: [],
    },
    recoveryEmail: { type: String, trim: true, lowercase: true },
    recoveryEmailVerified: { type: Boolean, default: false },
    pendingRecoveryEmail: { type: String, trim: true, lowercase: true },
    // Les champs OTP ne quittent jamais la base : select:false les exclut de
    // toutes les réponses (me, login, refresh) sauf demande explicite.
    recoveryOtp: { type: String, select: false },
    recoveryOtpExpireAt: { type: Date, select: false },
    recoveryOtpAttempts: { type: Number, default: 0, select: false },
    resetOtp: { type: String, select: false },
    resetOtpExpireAt: { type: Date, select: false },
    resetOtpAttempts: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

export type UserPublic = {
  _id: unknown;
  name: string;
  slug: string;
  phone: string;
  countryCode?: string;
  fullPhone?: string;
  description: string;
  logo: string;
  address: string;
  coverColor: string;
  role: 'admin' | 'user';
  createdAt: Date;
  updatedAt: Date;
};

// Optimise le $match { role: 'user', isActive: { $ne: false } } du pipeline public/shops
userSchema.index({ role: 1, isActive: 1 });
// Recherches de forgot-password / verify-otp et du refresh token
userSchema.index({ recoveryEmail: 1 }, { sparse: true });
userSchema.index({ 'refreshTokens.tokenHash': 1 });

const User: Model<IUser> =
  mongoose.models.User ?? mongoose.model<IUser>('User', userSchema);

export default User;
