/**
 * Migration — index du registre des événements appliqués (lot 3, J7).
 *
 * Crée l'index unique `{ linkId: 1, seq: 1 }` sur la collection `appliedevents` :
 * garantit l'idempotence du consommateur de flux GestStock (un seq ne peut être
 * appliqué qu'une seule fois par liaison). Crée aussi l'index unique `{ linkId: 1 }`
 * sur la collection `syncstates` : au plus un état de synchronisation par liaison.
 *
 * Ne supprime rien et peut être relancé sans risque : `createIndex` sur un index
 * identique est sans effet. Un index de même nom aux options différentes fait
 * échouer le script sans rien modifier.
 *
 * Usage : node --env-file=.env.local scripts/migrate-sync-cursor.mjs
 */
import mongoose from 'mongoose';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI est absente.');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  // appliedevents : idempotence des événements appliqués
  const appliedName = await mongoose.connection
    .collection('appliedevents')
    .createIndex({ linkId: 1, seq: 1 }, { unique: true });
  console.log(`appliedevents : index ${appliedName} présent.`);

  // syncstates : unicité de l'état par liaison
  const syncName = await mongoose.connection
    .collection('syncstates')
    .createIndex({ linkId: 1 }, { unique: true });
  console.log(`syncstates : index ${syncName} présent.`);
} finally {
  await mongoose.disconnect();
}
