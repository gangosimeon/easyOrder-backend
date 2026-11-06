/**
 * Migration — index du registre de synchronisation du catalogue (lot 3, J7b).
 *
 * Crée l'index unique `{ linkId: 1 }` sur la collection `syncstates` : au plus un état
 * de synchronisation par liaison. Peut être relancé sans risque : `createIndex` sur un
 * index identique est sans effet. Un index de même nom aux options différentes fait
 * échouer le script sans rien modifier.
 *
 * Usage : node --env-file=.env.local scripts/migrate-sync-cursor.mjs
 * Test d'idempotence : node --env-file=.env.local scripts/migrate-sync-cursor.mjs --test
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const testMode = process.argv.includes('--test');

async function run(uri) {
  await mongoose.connect(uri);
  try {
    const syncName = await mongoose.connection
      .collection('syncstates')
      .createIndex({ linkId: 1 }, { unique: true });
    console.log(`syncstates : index ${syncName} présent.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (testMode) {
  // Test d'idempotence : exécution deux fois sur la même base en mémoire
  console.log('Mode test d\'idempotence...');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  try {
    await run(uri);
    console.log('Première exécution : OK');
    await run(uri);
    console.log('Deuxième exécution (idempotence) : OK');
    console.log('Test réussi.');
  } catch (err) {
    console.error('Test échoué :', err.message);
    process.exit(1);
  } finally {
    await mongod.stop();
  }
} else {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI est absente.');
    process.exit(1);
  }
  await run(process.env.MONGODB_URI);
}
