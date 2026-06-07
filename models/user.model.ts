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
  recoveryEmail?: string;
  recoveryEmailVerified: boolean;
  recoveryOtp?: string;
  recoveryOtpExpireAt?: Date;
  resetOtp?: string;
  resetOtpExpireAt?: Date;
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
    password:    { type: String, required: true },
    description: { type: String, default: '' },
    logo:        { type: String, default: '🏪' },
    address:     { type: String, default: '' },
    coverColor:  { type: String, default: '#a04343' },
    role:        { type: String, enum: ['admin', 'user'], default: 'user' },
    isActive:    { type: Boolean, default: true },
    recoveryEmail: { type: String, trim: true, lowercase: true },
    recoveryEmailVerified: { type: Boolean, default: false },
    recoveryOtp: { type: String },
    recoveryOtpExpireAt: { type: Date },
    resetOtp: { type: String },
    resetOtpExpireAt: { type: Date },
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

const User: Model<IUser> =
  mongoose.models.User ?? mongoose.model<IUser>('User', userSchema);

export default User;
