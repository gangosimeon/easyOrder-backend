import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Les tests ne touchent jamais une vraie base : MongoDB en mémoire, jetable.
let mongo: MongoMemoryServer;

// Emails et notifications push : interceptés, jamais envoyés. Les tests lisent
// le code qu'aurait reçu l'utilisateur via vi.mocked(sendOtpEmail).mock.calls.
vi.mock('@/lib/mailer', () => ({
  isMailerConfigured: () => true,
  sendOtpEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/services/push-notification.service', () => ({
  sendPushToUser: vi.fn(async () => undefined),
}));

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  process.env.MONGODB_URI = mongo.getUri();
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
});

beforeEach(async () => {
  vi.clearAllMocks();
  if (mongoose.connection.readyState === 1) {
    await Promise.all(
      Object.values(mongoose.connection.collections).map(c => c.deleteMany({}))
    );
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
