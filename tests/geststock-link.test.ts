import { randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectDB } from '@/lib/db';
import { LinkSecretError } from '@/lib/integration-crypto';
import GeststockLink from '@/models/geststock-link.model';
import {
  GeststockLinkConflictError,
  GeststockLinkRepository,
  NewGeststockLink,
} from '@/repositories/geststock-link.repository';

/**
 * Liaison GestStock côté boutique (lot 2, J2 ; plan v14 §27, v14-D2, contrat `Link`) : au plus une liaison non
 * révoquée par boutique (index unique), secret seulement chiffré (J1) et jamais sérialisé, liaison révoquée
 * définitive, motif inconnu toléré.
 */

const INTEGRATION_VARIABLES = [
  'GESTSTOCK_INTEGRATION_ENABLED',
  'GESTSTOCK_LINK_ENCRYPTION_KEY',
  'GESTSTOCK_LINK_ENCRYPTION_KEY_ID',
  'GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS',
] as const;

const repository = new GeststockLinkRepository();

function shopId(): string {
  return new mongoose.Types.ObjectId().toString();
}

describe('Liaison GestStock (geststocklinks)', () => {
  const saved: Record<string, string | undefined> = {};
  const sensitive: string[] = [];
  const output: string[] = [];

  function remember(value: string): string {
    if (value.length > 0) sensitive.push(value);
    return value;
  }

  function newLink(shop: string, overrides: Partial<NewGeststockLink> = {}): NewGeststockLink {
    return {
      shopId: shop,
      linkId: randomUUID(),
      companyCode: 'optique-principale',
      companyName: 'Optique Principale',
      currency: 'XOF',
      scopes: ['catalog:read', 'stock:read'],
      warehouses: [{ warehouseId: randomUUID(), name: 'Magasin Plateau', active: true }],
      linkedAt: new Date('2026-10-30T10:00:00Z'),
      secret: remember(randomBytes(32).toString('base64url')),
      ...overrides,
    };
  }

  /** Document brut de la collection (aucune transformation de Mongoose). */
  async function raw(linkId: string): Promise<Record<string, unknown> | null> {
    return mongoose.connection.collection('geststocklinks').findOne({ linkId });
  }

  beforeAll(async () => {
    await connectDB();
    await GeststockLink.init();
  });

  beforeEach(() => {
    for (const name of INTEGRATION_VARIABLES) saved[name] = process.env[name];
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID = 'k-test';
    delete process.env.GESTSTOCK_LINK_ENCRYPTION_OLD_KEYS;
    sensitive.length = 0;
    output.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of INTEGRATION_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    const logs = output.join('\n');
    for (const value of sensitive) expect(logs).not.toContain(value);
  });

  // --- Unicité ----------------------------------------------------------------------------------------

  it('deuxième liaison non révoquée pour la même boutique : refusée', async () => {
    const shop = shopId();
    await repository.createActiveLink(newLink(shop));
    await expect(repository.createActiveLink(newLink(shop))).rejects.toBeInstanceOf(GeststockLinkConflictError);
    expect(await GeststockLink.countDocuments({ shopId: shop })).toBe(1);
  });

  it('deux créations simultanées pour la même boutique : une seule réussit', async () => {
    const shop = shopId();
    const results = await Promise.allSettled([repository.createActiveLink(newLink(shop)), repository.createActiveLink(newLink(shop))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(GeststockLinkConflictError);
  });

  it('ancienne liaison révoquée : une nouvelle est acceptée ; une suspendue bloque toujours', async () => {
    const shop = shopId();
    const first = await repository.createActiveLink(newLink(shop));
    await repository.applyRemoteState(shop, first.linkId, { status: 'SUSPENDED', suspensionReason: 'MANUAL', syncedAt: new Date() });
    await expect(repository.createActiveLink(newLink(shop))).rejects.toBeInstanceOf(GeststockLinkConflictError);
    await repository.revoke(shop, first.linkId, 'SHOP_REQUEST', new Date());
    const second = await repository.createActiveLink(newLink(shop));
    expect(second.status).toBe('ACTIVE');
    expect((await repository.findCurrentByShop(shop))?.linkId).toBe(second.linkId);
  });

  it('index unique partiel sur la boutique, présent seulement tant que la liaison n’est pas révoquée', async () => {
    const indexes = await mongoose.connection.collection('geststocklinks').indexes();
    const unique = indexes.find((index) => index.key.activeShopId === 1);
    expect(unique?.unique).toBe(true);
    expect(unique?.partialFilterExpression).toEqual({ activeShopId: { $exists: true } });
    expect(indexes.find((index) => index.key.linkId === 1)?.unique).toBe(true);
  });

  // --- Secret -------------------------------------------------------------------------------------------

  it('secret seulement chiffré en base, absent de toJSON, toObject et des résultats', async () => {
    const shop = shopId();
    const input = newLink(shop);
    const view = await repository.createActiveLink(input);
    const stored = await raw(input.linkId);
    const encrypted = remember(String(stored?.encryptedSecret));
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(encrypted).not.toContain(input.secret);
    expect(JSON.stringify(stored)).not.toContain(input.secret);

    const document = await GeststockLink.findOne({ linkId: input.linkId });
    expect(document?.get('encryptedSecret')).toBeUndefined();
    const explicit = await GeststockLink.findOne({ linkId: input.linkId }).select('+encryptedSecret');
    expect(explicit?.get('encryptedSecret')).toBe(encrypted);
    for (const serialized of [JSON.stringify(explicit), JSON.stringify(explicit?.toObject()), JSON.stringify(explicit?.toJSON())]) {
      expect(serialized).not.toContain(encrypted);
      expect(serialized).not.toContain('encryptedSecret');
    }
    for (const result of [view, await repository.findCurrentByShop(shop), await repository.findByLinkId(shop, input.linkId)]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(encrypted);
      expect(serialized).not.toContain(input.secret);
      expect(serialized).not.toContain('ncryptedSecret');
    }
  });

  it('secret lu seulement par une demande explicite, avec les bonnes AAD', async () => {
    const shop = shopId();
    const input = newLink(shop);
    await repository.createActiveLink(input);
    expect(await repository.revealSecret(shop, input.linkId)).toBe(input.secret);
    expect(await repository.revealSecret(shopId(), input.linkId)).toBeNull();
  });

  it('secret chiffré déplacé vers une autre liaison : déchiffrement refusé', async () => {
    const first = newLink(shopId());
    const second = newLink(shopId());
    await repository.createActiveLink(first);
    await repository.createActiveLink(second);
    const stolen = (await raw(first.linkId))?.encryptedSecret;
    remember(String(stolen));
    await mongoose.connection.collection('geststocklinks').updateOne({ linkId: second.linkId }, { $set: { encryptedSecret: stolen } });
    await expect(repository.revealSecret(second.shopId, second.linkId)).rejects.toBeInstanceOf(LinkSecretError);
  });

  it('emplacement du secret en attente de rotation : chiffré, jamais sérialisé', async () => {
    const shop = shopId();
    const input = newLink(shop);
    await repository.createActiveLink(input);
    const paths = GeststockLink.schema.paths;
    expect(paths.pendingEncryptedSecret.options.select).toBe(false);
    expect(paths.encryptedSecret.options.select).toBe(false);
    expect(paths.pendingSecretCreatedAt).toBeDefined();
  });

  // --- Statuts ------------------------------------------------------------------------------------------

  it('une liaison révoquée ne revient à aucun autre statut ; secrets effacés', async () => {
    const shop = shopId();
    const input = newLink(shop);
    await repository.createActiveLink(input);
    const revoked = await repository.revoke(shop, input.linkId, 'GESTSTOCK_ADMIN', new Date('2026-10-31T08:00:00Z'));
    expect(revoked?.status).toBe('REVOKED');
    expect(revoked?.revocationReason).toBe('GESTSTOCK_ADMIN');

    for (const status of ['ACTIVE', 'SUSPENDED'] as const) {
      expect(await repository.applyRemoteState(shop, input.linkId, { status, syncedAt: new Date() })).toBeNull();
    }
    // Même par une mise à jour directe du modèle, ou par un enregistrement du document.
    await GeststockLink.updateOne({ linkId: input.linkId }, { $set: { status: 'ACTIVE' } });
    await GeststockLink.findOneAndUpdate({ linkId: input.linkId }, { status: 'SUSPENDED' });
    const document = await GeststockLink.findOne({ linkId: input.linkId });
    document!.set('status', 'ACTIVE');
    await expect(document!.save({ validateBeforeSave: false })).rejects.toThrow(/révoquée/);

    const stored = await raw(input.linkId);
    expect(stored?.status).toBe('REVOKED');
    expect(stored?.encryptedSecret).toBeUndefined();
    expect(stored?.activeShopId).toBeUndefined();
    expect(await repository.revealSecret(shop, input.linkId)).toBeNull();
    expect(await repository.findCurrentByShop(shop)).toBeNull();
  });

  it('état distant appliqué par une mise à jour conditionnelle ; motif inconnu toléré', async () => {
    const shop = shopId();
    const input = newLink(shop);
    await repository.createActiveLink(input);
    const synced = new Date('2026-10-31T09:00:00Z');
    const suspended = await repository.applyRemoteState(shop, input.linkId, {
      status: 'SUSPENDED',
      suspensionReason: 'NOUVEAU_MOTIF_INCONNU',
      warehouses: [{ warehouseId: randomUUID(), name: 'Entrepôt', active: false, priority: 2 }],
      syncedAt: synced,
    });
    expect(suspended?.status).toBe('SUSPENDED');
    expect(suspended?.suspensionReason).toBe('NOUVEAU_MOTIF_INCONNU');
    expect(suspended?.warehouses[0]).toMatchObject({ name: 'Entrepôt', active: false, priority: 2 });
    expect(suspended?.lastStateSyncAt?.toISOString()).toBe(synced.toISOString());

    const revoked = await repository.applyRemoteState(shop, input.linkId, {
      status: 'REVOKED',
      revocationReason: 'MOTIF_FUTUR',
      revokedAt: new Date(),
      syncedAt: new Date(),
    });
    expect(revoked?.status).toBe('REVOKED');
    expect(revoked?.revocationReason).toBe('MOTIF_FUTUR');
  });

  it('statut distant inconnu ou en attente : refusé, la liaison reste inchangée', async () => {
    const shop = shopId();
    const input = newLink(shop);
    await repository.createActiveLink(input);
    await expect(repository.applyRemoteState(shop, input.linkId, { status: 'PENDING', syncedAt: new Date() })).rejects.toThrow();
    await expect(repository.applyRemoteState(shop, input.linkId, { status: 'ARCHIVED', syncedAt: new Date() })).rejects.toThrow();
    expect((await repository.findByLinkId(shop, input.linkId))?.status).toBe('ACTIVE');
  });

  it('autre boutique : aucune liaison visible ni modifiable', async () => {
    const shop = shopId();
    const input = newLink(shop);
    await repository.createActiveLink(input);
    const other = shopId();
    expect(await repository.findByLinkId(other, input.linkId)).toBeNull();
    expect(await repository.revoke(other, input.linkId, 'SHOP_REQUEST', new Date())).toBeNull();
    expect((await repository.findByLinkId(shop, input.linkId))?.status).toBe('ACTIVE');
  });
});
