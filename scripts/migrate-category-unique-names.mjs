/**
 * Migration — unicité des noms de catégorie par boutique (insensible à la casse/espaces).
 *
 * Contexte : `models/category.model.ts` ajoute un champ `normalizedName`
 * (trim + lowercase de `name`) avec un index unique {shopId, normalizedName}.
 * Ce script backfille `normalizedName` sur les catégories existantes puis
 * crée l'index — nécessaire une seule fois par environnement (déjà exécuté
 * en production le 2026-09-07 : 49 catégories, 0 doublon trouvé).
 *
 * Ré-exécutable sans risque (idempotent) : à relancer sur tout autre
 * environnement (staging, restauration de sauvegarde) avant de déployer
 * cette fonctionnalité.
 *
 * Usage : node --env-file=.env.local scripts/migrate-category-unique-names.mjs
 */
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
const coll = db.collection('categories');

const categories = await coll.find({}).toArray();
console.log('total categories:', categories.length);

const normalize = (name) => (name || '').trim().toLowerCase();

const groups = new Map();
for (const cat of categories) {
  const key = `${cat.shopId}::${normalize(cat.name)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(cat);
}

const duplicates = [...groups.entries()].filter(([, docs]) => docs.length > 1);
console.log('duplicate groups found:', duplicates.length);
for (const [key, docs] of duplicates) {
  console.log('  DUP', key, docs.map(d => ({ id: String(d._id), name: d.name, createdAt: d.createdAt })));
}

// Backfill normalizedName sur toutes les catégories (sûr même s'il reste des doublons).
const bulk = categories.map(cat => ({
  updateOne: {
    filter: { _id: cat._id },
    update: { $set: { normalizedName: normalize(cat.name) } },
  },
}));
if (bulk.length) {
  const result = await coll.bulkWrite(bulk);
  console.log('backfilled normalizedName on', result.modifiedCount, 'documents');
}

if (duplicates.length === 0) {
  await coll.createIndex({ shopId: 1, normalizedName: 1 }, { unique: true });
  console.log('unique index created: {shopId:1, normalizedName:1}');
} else {
  console.log('SKIPPED index creation — resolve the duplicate groups above first (rename/merge), then re-run this script.');
}

await mongoose.disconnect();
