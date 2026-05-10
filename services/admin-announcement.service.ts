import AdminAnnouncement from '@/models/admin-announcement.model';
import type {
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from '@/validators/admin-announcement.validator';

export async function listAnnouncements(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    AdminAnnouncement.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AdminAnnouncement.countDocuments(),
  ]);
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getAnnouncementById(id: string) {
  return AdminAnnouncement.findById(id).lean();
}

export async function createAnnouncement(
  input: CreateAnnouncementInput,
  adminId: string,
) {
  const doc = await AdminAnnouncement.create({
    ...input,
    expireAt:  input.expireAt ? new Date(input.expireAt) : null,
    createdBy: adminId,
  });
  return doc;
}

export async function updateAnnouncement(id: string, input: UpdateAnnouncementInput) {
  const update: Record<string, unknown> = { ...input };
  if ('expireAt' in input) {
    update.expireAt = input.expireAt ? new Date(input.expireAt) : null;
  }
  const doc = await AdminAnnouncement.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  return doc;
}

export async function deleteAnnouncement(id: string) {
  const doc = await AdminAnnouncement.findByIdAndDelete(id);
  if (!doc) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
}

export async function toggleAnnouncement(id: string) {
  const doc = await AdminAnnouncement.findById(id);
  if (!doc) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  doc.active = !doc.active;
  await doc.save();
  return doc.toObject();
}

export async function getActiveAnnouncementsForShop(shopId: string) {
  const now = new Date();
  return AdminAnnouncement.find({
    active: true,
    $and: [
      { $or: [{ expireAt: null }, { expireAt: { $gt: now } }] },
      { $or: [{ targetShops: { $size: 0 } }, { targetShops: shopId }] },
    ],
  })
    .sort({ createdAt: -1 })
    .select('-createdBy')
    .lean();
}
