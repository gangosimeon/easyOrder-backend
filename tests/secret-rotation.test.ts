import { randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectDB } from '@/lib/db';
import { encryptLinkSecret } from '@/lib/integration-crypto';
import GeststockLink from '@/models/geststock-link.model';
import User from '@/models/user.model';
import { GeststockLinkRepository } from '@/repositories/geststock-link.repository';
import { geststockClient } from '@/services/geststock-link.service';
import { POST as initiateRotation, DELETE as cancelRotation } from '@/app/api/integrations/geststock/rotate-secret/route';
import { POST as commitRotation } from '@/app/api/integrations/geststock/rotate-secret/commit/route';
import { createShop, jsonRequest } from './helpers';

/**
 * Routes de rotation du secret GestStock (lot 3, J12.2, G14) :
 * POST   /api/integrations/geststock/rotate-secret        — initier
 * POST   /api/integrations/geststock/rotate-secret/commit — valider
 * DELETE /api/integrations/geststock/rotate-secret        — annuler
 */

const VARIABLES = [
  'GESTSTOCK_INTEGRATION_ENABLED',
  'GESTSTOCK_LINK_ENCRYPTION_KEY',
  'GESTSTOCK_LINK_ENCRYPTION_KEY_ID',
  'GESTSTOCK_API_ORIGIN',
  'GESTSTOCK_FRONTEND_ORIGIN',
  'GESTSTOCK_CLIENT_ID',
  'GESTSTOCK_CLIENT_SECRET',
  'GESTSTOCK_REDIRECT_URI',
] as const;

let phoneCounter = 0;
function phone(): string {
  phoneCounter += 1;
  return `79${String(phoneCounter).padStart(6, '0')}`;
}

describe('Rotation du secret GestStock (lot 3, J12.2)', () => {
  const saved: Record<string, string | undefined> = {};
  const links = new GeststockLinkRepository();

  beforeEach(async () => {
    await connectDB();
    await GeststockLink.init();

    for (const name of VARIABLES) saved[name] = process.env[name];
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID = 'k-rot';
    process.env.GESTSTOCK_API_ORIGIN = 'https://api.geststock.test';
    process.env.GESTSTOCK_FRONTEND_ORIGIN = 'https://app.geststock.test';
    process.env.GESTSTOCK_CLIENT_ID = 'jcmb';
    process.env.GESTSTOCK_CLIENT_SECRET = randomBytes(16).toString('hex');
    process.env.GESTSTOCK_REDIRECT_URI = 'https://www.jecreemaboutique.com/integrations/geststock/callback';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('appel réseau interdit dans les tests'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  /** Boutique approuvée avec liaison ACTIVE. */
  async function linkedShop(): Promise<{ shopId: string; token: string; linkId: string }> {
    const s = await createShop('Boutique Rotation', phone());
    await User.updateOne({ _id: s.id }, { isActive: true });
    const linkId = randomUUID();
    const encryptedSecret = encryptLinkSecret('initial-secret', { linkId, shopId: s.id });
    await GeststockLink.create({
      shopId: new mongoose.Types.ObjectId(s.id),
      activeShopId: new mongoose.Types.ObjectId(s.id),
      linkId,
      status: 'ACTIVE',
      companyCode: 'ROT',
      companyName: null,
      currency: 'XOF',
      scopes: [],
      warehouses: [],
      linkedAt: new Date(),
      lastStateSyncAt: null,
      revokedAt: null,
      suspensionReason: null,
      revocationReason: null,
      pendingSecretCreatedAt: null,
      encryptedSecret,
    });
    return { shopId: s.id, token: s.token, linkId };
  }

  it('POST /rotate-secret — initie la rotation, pendingSecretCreatedAt posé', async () => {
    const { shopId, token, linkId } = await linkedShop();
    vi.spyOn(geststockClient, 'initiateSecretRotation').mockResolvedValueOnce({ newSecret: 'new-secret-plain' });

    const req = jsonRequest('/api/integrations/geststock/rotate-secret', {}, { token });
    const resp = await initiateRotation(req);
    expect(resp.status).toBe(200);

    const link = await GeststockLink.findOne({ shopId: new mongoose.Types.ObjectId(shopId), linkId }).lean();
    expect(link?.pendingSecretCreatedAt).toBeInstanceOf(Date);
    // le pending secret chiffré est en DB (select:false, non sérialisé dans la vue)
    const raw = await GeststockLink.findOne({ shopId: new mongoose.Types.ObjectId(shopId), linkId }).select('+pendingEncryptedSecret').lean();
    expect(raw?.pendingEncryptedSecret).toBeTruthy();
  });

  it('POST /rotate-secret/commit — valide la rotation, secrets swappés, pending effacé', async () => {
    const { shopId, token, linkId } = await linkedShop();
    vi.spyOn(geststockClient, 'initiateSecretRotation').mockResolvedValueOnce({ newSecret: 'new-secret-plain' });
    vi.spyOn(geststockClient, 'commitSecretRotation').mockResolvedValueOnce(undefined);

    // Initier d'abord
    await initiateRotation(jsonRequest('/api/integrations/geststock/rotate-secret', {}, { token }));

    // Capturer le pending avant commit
    const before = await GeststockLink.findOne({ shopId: new mongoose.Types.ObjectId(shopId), linkId })
      .select('+pendingEncryptedSecret +encryptedSecret').lean();
    expect(before?.pendingEncryptedSecret).toBeTruthy();

    // Valider
    const resp = await commitRotation(jsonRequest('/api/integrations/geststock/rotate-secret/commit', {}, { token }));
    expect(resp.status).toBe(200);

    // Après commit : pending effacé, encryptedSecret ≠ initial
    const after = await GeststockLink.findOne({ shopId: new mongoose.Types.ObjectId(shopId), linkId })
      .select('+pendingEncryptedSecret +encryptedSecret').lean();
    expect(after?.pendingSecretCreatedAt).toBeNull();
    expect(after?.pendingEncryptedSecret).toBeFalsy();
    // Le nouveau encryptedSecret est celui qui était en pending
    expect(after?.encryptedSecret).toBe(before?.pendingEncryptedSecret);
  });

  it('POST /rotate-secret/commit — 409 si aucune rotation en cours', async () => {
    const { token } = await linkedShop();
    const resp = await commitRotation(jsonRequest('/api/integrations/geststock/rotate-secret/commit', {}, { token }));
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.code).toBe('NO_PENDING_ROTATION');
  });

  it('DELETE /rotate-secret — annule la rotation, pending effacé', async () => {
    const { shopId, token, linkId } = await linkedShop();
    vi.spyOn(geststockClient, 'initiateSecretRotation').mockResolvedValueOnce({ newSecret: 'new-secret-plain' });
    vi.spyOn(geststockClient, 'cancelSecretRotation').mockResolvedValueOnce(undefined);

    // Initier
    await initiateRotation(jsonRequest('/api/integrations/geststock/rotate-secret', {}, { token }));

    // Vérifier qu'il y a un pending
    const mid = await GeststockLink.findOne({ shopId: new mongoose.Types.ObjectId(shopId), linkId }).lean();
    expect(mid?.pendingSecretCreatedAt).toBeInstanceOf(Date);

    // Annuler
    const req = jsonRequest('/api/integrations/geststock/rotate-secret', undefined, { token, method: 'DELETE' });
    const resp = await cancelRotation(req);
    expect(resp.status).toBe(200);

    // Pending effacé
    const after = await GeststockLink.findOne({ shopId: new mongoose.Types.ObjectId(shopId), linkId }).lean();
    expect(after?.pendingSecretCreatedAt).toBeNull();
  });

  it('DELETE /rotate-secret — 404 sans liaison active', async () => {
    // Boutique sans liaison
    const s = await createShop('Boutique Sans Liaison', phone());
    await User.updateOne({ _id: s.id }, { isActive: true });
    const req = jsonRequest('/api/integrations/geststock/rotate-secret', undefined, { token: s.token, method: 'DELETE' });
    const resp = await cancelRotation(req);
    expect(resp.status).toBe(404);
  });

  it('POST /rotate-secret — 401 sans token', async () => {
    const req = jsonRequest('/api/integrations/geststock/rotate-secret', {});
    const resp = await initiateRotation(req);
    expect(resp.status).toBe(401);
  });
});
