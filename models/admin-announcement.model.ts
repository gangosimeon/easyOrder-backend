import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminAnnouncement extends Document {
  title:       string;
  content:     string;
  type:        'info' | 'warning' | 'success' | 'urgent';
  active:      boolean;
  targetShops: mongoose.Types.ObjectId[];
  expireAt:    Date | null;
  createdBy:   mongoose.Types.ObjectId;
  createdAt:   Date;
  updatedAt:   Date;
}

const AdminAnnouncementSchema = new Schema<IAdminAnnouncement>(
  {
    title:       { type: String, required: true, trim: true, maxlength: 200 },
    content:     { type: String, required: true, trim: true, maxlength: 2000 },
    type:        { type: String, enum: ['info', 'warning', 'success', 'urgent'], default: 'info' },
    active:      { type: Boolean, default: true },
    targetShops: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    expireAt:    { type: Date, default: null },
    createdBy:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

AdminAnnouncementSchema.index({ active: 1, expireAt: 1 });
AdminAnnouncementSchema.index({ targetShops: 1 });

const AdminAnnouncement =
  mongoose.models.AdminAnnouncement ??
  mongoose.model<IAdminAnnouncement>('AdminAnnouncement', AdminAnnouncementSchema);

export default AdminAnnouncement;
