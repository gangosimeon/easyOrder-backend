import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectDB } from '@/lib/db';
import GeststockAuthorizationRequest from '@/models/geststock-authorization-request.model';
import GeststockLink from '@/models/geststock-link.model';
import { GeststockAuthorizationRequestRepository } from '@/repositories/geststock-authorization-request.repository';

/**
 * Demande d'autorisation en cours (lot 2, J2 ; v14-D1 étapes 1 et 4) : `state` stocké par son empreinte seulement,
 * vérificateur PKCE chiffré (J1), consommation unique et atomique, expiration vérifiée explicitement (le TTL ne
 * fait que nettoyer) ; script d'index idempotent.
 */

const INTEGRATION_VARIABLES = ['GESTSTOCK_INTEGRATION_ENABLED', 'GESTSTOCK_LINK_ENCRYPTION_KEY', 'GESTSTOCK_LINK_ENCRYPTION_KEY_ID'] as const;
const COLLECTION = 'geststockauthorizationrequests';
const repository = new GeststockAuthorizationRequestRepository();
const run = promisify(execFile);

function shopId(): string {
  return new mongoose.Types.ObjectId().toString();
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

describe('Demande d’autorisation GestStock', () => {
  const saved: Record<string, string | undefined> = {};
  const sensitive: string[] = [];
  const output: string[] = [];

  function remember(value: string): string {
    if (value.length > 0) sensitive.push(value);
    return value;
  }

  function request(shop: string, now = new Date()) {
    return {
      shopId: shop,
      state: remember(token()),
      codeVerifier: remember(`${token()}-verifier`),
      requestUri: 'urn:ietf:params:oauth:request_uri:Zx9',
      redirectUri: 'https://www.jecreemaboutique.com/integrations/geststock/callback',
      now,
    };
  }

  beforeAll(async () => {
    await connectDB();
    await GeststockAuthorizationRequest.init();
  });

  beforeEach(() => {
    for (const name of INTEGRATION_VARIABLES) saved[name] = process.env[name];
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID = 'k-test';
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

  it('state stocké seulement par son empreinte SHA-256 ; vérificateur chiffré ; expiration à 10 min', async () => {
    const shop = shopId();
    const input = request(shop, new Date('2026-10-30T10:00:00Z'));
    const created = await repository.create(input);
    expect(created.expiresAt.toISOString()).toBe('2026-10-30T10:10:00.000Z');

    const stored = await mongoose.connection.collection(COLLECTION).findOne({ _id: new mongoose.Types.ObjectId(created.id) });
    expect(stored?.stateHash).toBe(createHash('sha256').update(input.state).digest('hex'));
    expect(String(stored?.encryptedCodeVerifier).startsWith('v1.')).toBe(true);
    remember(String(stored?.encryptedCodeVerifier));
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(input.state);
    expect(serialized).not.toContain(input.codeVerifier);
    expect(stored?.usedAt).toBeNull();

    const document = await GeststockAuthorizationRequest.findById(created.id);
    expect(document?.get('encryptedCodeVerifier')).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('encryptedCodeVerifier');
  });

  it('consommation unique : vérificateur et adresses rendus une fois, puis refus', async () => {
    const shop = shopId();
    const input = request(shop);
    const created = await repository.create(input);
    const consumed = await repository.consume({ shopId: shop, state: input.state });
    expect(consumed).toEqual({
      id: created.id,
      requestUri: input.requestUri,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    expect(await repository.consume({ shopId: shop, state: input.state })).toBeNull();
  });

  it('deux consommations simultanées : une seule réussit', async () => {
    const shop = shopId();
    const input = request(shop);
    await repository.create(input);
    const results = await Promise.all([
      repository.consume({ shopId: shop, state: input.state }),
      repository.consume({ shopId: shop, state: input.state }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('demande expirée : refusée même avant le passage du TTL', async () => {
    const shop = shopId();
    const input = request(shop, new Date(Date.now() - 11 * 60_000));
    const created = await repository.create(input);
    expect(await repository.consume({ shopId: shop, state: input.state })).toBeNull();
    // Toujours présente (le moniteur TTL ne passe que toutes les 60 s) et non consommée.
    const stored = await mongoose.connection.collection(COLLECTION).findOne({ _id: new mongoose.Types.ObjectId(created.id) });
    expect(stored?.usedAt).toBeNull();
  });

  it('autre boutique : refusée, la demande reste utilisable par la bonne boutique', async () => {
    const shop = shopId();
    const input = request(shop);
    await repository.create(input);
    expect(await repository.consume({ shopId: shopId(), state: input.state })).toBeNull();
    expect((await repository.consume({ shopId: shop, state: input.state }))?.codeVerifier).toBe(input.codeVerifier);
  });

  it('state inconnu ou mal formé : refusé', async () => {
    expect(await repository.consume({ shopId: shopId(), state: token() })).toBeNull();
    expect(await repository.consume({ shopId: shopId(), state: '' })).toBeNull();
  });

  it('index : TTL sur expiresAt, state unique', async () => {
    const indexes = await mongoose.connection.collection(COLLECTION).indexes();
    expect(indexes.find((index) => index.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
    expect(indexes.find((index) => index.key.stateHash === 1)?.unique).toBe(true);
  });

  it('script d’index : crée les index, idempotent (deux exécutions), sans rien supprimer', async () => {
    await GeststockLink.init();
    const script = path.resolve(__dirname, '../scripts/migrate-geststock-link.mjs');
    const uri = new URL(process.env.MONGODB_URI!);
    // Base vide dédiée : les index viennent du script seul.
    uri.pathname = '/geststock-script-test';
    const fresh = mongoose.connection.useDb('geststock-script-test', { useCache: false });
    await fresh.collection('geststocklinks').insertOne({ marker: 'conservé' });
    for (const target of [uri.toString(), uri.toString(), process.env.MONGODB_URI!]) {
      const { stdout } = await run(process.execPath, [script], { env: { ...process.env, MONGODB_URI: target } });
      expect(stdout).not.toContain('mongodb://');
    }
    const links = await fresh.collection('geststocklinks').indexes();
    expect(links.find((index) => index.key.activeShopId === 1)?.partialFilterExpression).toEqual({ activeShopId: { $exists: true } });
    expect(links.find((index) => index.key.linkId === 1)?.unique).toBe(true);
    const requests = await fresh.collection(COLLECTION).indexes();
    expect(requests.find((index) => index.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
    expect(requests.find((index) => index.key.stateHash === 1)?.unique).toBe(true);
    expect(await fresh.collection('geststocklinks').countDocuments({ marker: 'conservé' })).toBe(1);
    await fresh.dropDatabase();
  }, 60_000);
});
