/**
 * Migration — index de l'intégration GestStock (lot 2, J2).
 *
 * Crée les index des collections `geststocklinks` et `geststockauthorizationrequests`, identiques à ceux déclarés
 * dans `models/geststock-link.model.ts` et `models/geststock-authorization-request.model.ts` (mêmes clés, mêmes
 * options, mêmes noms) :
 * - `geststocklinks` : `linkId` unique ; `shopId` ; `activeShopId` unique partiel (`$exists: true`) : au plus une
 *   liaison non révoquée par boutique (v14-D2) ;
 * - `geststockauthorizationrequests` : `stateHash` unique ; `shopId` ; TTL sur `expiresAt` (`expireAfterSeconds: 0`).
 *
 * Mongoose crée aussi ces index au démarrage (autoIndex) ; ce script les pose explicitement avant le déploiement de
 * l'intégration, comme `migrate-category-unique-names.mjs`. Il ne supprime rien (ni index, ni document) et peut être
 * relancé sans risque : `createIndex` d'un index identique ne fait rien. Un index de même nom aux options
 * différentes fait échouer le script, sans rien modifier.
 *
 * Usage : node --env-file=.env.local scripts/migrate-geststock-link.mjs
 */
import mongoose from 'mongoose';

const INDEXES = {
  geststocklinks: [
    { key: { linkId: 1 }, options: { unique: true } },
    { key: { shopId: 1 }, options: {} },
    { key: { activeShopId: 1 }, options: { unique: true, partialFilterExpression: { activeShopId: { $exists: true } } } },
  ],
  geststockauthorizationrequests: [
    { key: { stateHash: 1 }, options: { unique: true } },
    { key: { shopId: 1 }, options: {} },
    { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ],
};

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI est absente.');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    const coll = mongoose.connection.collection(collection);
    for (const { key, options } of indexes) {
      const name = await coll.createIndex(key, options);
      console.log(`${collection} : index ${name} présent.`);
    }
  }
} finally {
  await mongoose.disconnect();
}
