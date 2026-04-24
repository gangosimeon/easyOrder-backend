import Annonce from '@/models/annonce.model';
import { CreateAnnonceInput, UpdateAnnonceInput } from '@/validators/annonce.validator';

export async function getAnnoncesByShop(shopId: string) {
  return Annonce.find({ shopId }).sort({ epinglee: -1, createdAt: -1 }).lean();
}

export async function getActiveAnnoncesByShop(shopId: string) {
  const now = new Date();
  return Annonce.find({
    shopId,
    active: true,
    dateDebut: { $lte: now },
    $or: [{ dateFin: { $exists: false } }, { dateFin: null }, { dateFin: { $gte: now } }],
  })
    .sort({ epinglee: -1, createdAt: -1 })
    .lean();
}

export async function getAnnonceById(id: string, shopId: string) {
  const ann = await Annonce.findOne({ _id: id, shopId }).lean();
  if (!ann) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  return ann;
}

export async function createAnnonce(shopId: string, data: CreateAnnonceInput) {
  return Annonce.create({ ...data, shopId });
}

export async function updateAnnonce(id: string, shopId: string, data: UpdateAnnonceInput) {
  const ann = await Annonce.findOneAndUpdate(
    { _id: id, shopId },
    { $set: data },
    { new: true, runValidators: true }
  );
  if (!ann) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  return ann;
}

export async function toggleAnnonceActive(id: string, shopId: string) {
  const ann = await Annonce.findOne({ _id: id, shopId });
  if (!ann) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  ann.active = !ann.active;
  await ann.save();
  return ann;
}

export async function toggleAnnonceEpinglee(id: string, shopId: string) {
  const ann = await Annonce.findOne({ _id: id, shopId });
  if (!ann) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  ann.epinglee = !ann.epinglee;
  await ann.save();
  return ann;
}

export async function deleteAnnonce(id: string, shopId: string) {
  const ann = await Annonce.findOneAndDelete({ _id: id, shopId });
  if (!ann) throw Object.assign(new Error('Annonce introuvable'), { status: 404 });
  return ann;
}
