import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  slug: string;
  phone: string;
  password: string;
  description: string;
  logo: string;
  address: string;
  coverColor: string;
  role: 'admin' | 'user';
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name:        { type: String, required: true, trim: true },
    slug:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone:       { type: String, required: true, unique: true, trim: true },
    password:    { type: String, required: true },
    description: { type: String, default: '' },
    logo:        { type: String, default: '🏪' },
    address:     { type: String, default: '' },
    coverColor:  { type: String, default: '#a04343' },
    role:        { type: String, enum: ['admin', 'user'], default: 'user' },
  },
  { timestamps: true }
);

export type UserPublic = {
  _id: unknown;
  name: string;
  slug: string;
  phone: string;
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
