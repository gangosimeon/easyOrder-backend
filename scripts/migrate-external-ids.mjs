/**
 * Migration — index des identifiants externes GestStock (lot 3, J6).
 *
 * Crée l'index unique partiel `{ shopId, external.source, external.id }` sur les collections
 * `products` et `categories`, identique à celui déclaré dans les modèles Mongoose :
 * - `partialFilterExpression: { 'external.source': { $exists: true } }` : l'index n'indexe que
 *   les documents portant un identifiant externe, les produits et catégories boutique purs ne
 *   sont pas affectés ;
 * - unique par boutique : deux produits de la même boutique ne peuvent pas pointer vers le même
 *   objet GestStock ; deux boutiques différentes peuvent pointer vers le même objet.
 *
 * Ne supprime rien (ni index, ni document) et peut être relancé sans risque : `createIndex` d'un
 * index identique ne fait rien. Un index de même nom aux options différentes fait échouer le
 * script, sans rien modifier.
 *
 * Usage : node --env-file=.env.local scripts/migrate-external-ids.mjs
 */
import mongoose from 'mongoose';

const KEY     = { shopId: 1, 'external.source': 1, 'external.id': 1 };
const OPTIONS = { unique: true, partialFilterExpression: { 'external.source': { $exists: true } } };

const COLLECTIONS = ['products', 'categories'];

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI est absente.');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  for (const name of COLLECTIONS) {
    const indexName = await mongoose.connection.collection(name).createIndex(KEY, OPTIONS);
    console.log(`${name} : index ${indexName} présent.`);
  }
} finally {
  await mongoose.disconnect();
}
