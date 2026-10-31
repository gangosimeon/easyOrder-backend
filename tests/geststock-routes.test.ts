import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as complete } from '@/app/api/integrations/geststock/complete/route';
import { GET as getLink } from '@/app/api/integrations/geststock/link/route';
import { POST as revoke } from '@/app/api/integrations/geststock/revoke/route';
import { POST as start } from '@/app/api/integrations/geststock/start/route';
import { signToken } from '@/lib/auth';
import { GeststockError, RemoteLink } from '@/lib/geststock-client';
import { decryptLinkSecret } from '@/lib/integration-crypto';
import GeststockAuthorizationRequest from '@/models/geststock-authorization-request.model';
import GeststockLink from '@/models/geststock-link.model';
import RateLimit from '@/models/rate-limit.model';
import User from '@/models/user.model';
import { GeststockAuthorizationRequestRepository } from '@/repositories/geststock-authorization-request.repository';
import { GeststockLinkRepository } from '@/repositories/geststock-link.repository';
import { COMPENSATION_REASON, geststockClient } from '@/services/geststock-link.service';
import { createShop, jsonRequest, TestShop } from './helpers';

/**
 * Routes de la liaison GestStock côté boutique (lot 2, J4 ; v14-D1, v14-D2, v14-D13, v14-D14) : démarrer, terminer,
 * consulter, révoquer. GeststockClient simulé (aucun appel réseau), MongoDB en mémoire.
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

const REDIRECT_URI = 'https://www.jecreemaboutique.com/integrations/geststock/callback';
const AUTHORIZE = 'https://app.geststock.test/integrations/jecreemaboutique/authorize?client_id=jcmb&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AZx9';

let phoneCounter = 0;

/** Numéro unique dans ce fichier (8 chiffres, comme les autres tests). */
function phone(): string {
  phoneCounter += 1;
  return `76${String(phoneCounter).padStart(6, '0')}`;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function remote(shopId: string, overrides: Partial<RemoteLink> = {}): RemoteLink {
  return {
    linkId: randomUUID(),
    status: 'ACTIVE',
    suspensionReason: null,
    revocationReason: null,
    companyCode: 'optique-principale',
    companyName: null,
    currency: 'XOF',
    externalShopId: shopId,
    scopes: ['catalog:read', 'stock:read'],
    warehouses: [{ warehouseId: randomUUID(), name: 'Magasin Plateau', active: true }],
    createdAt: new Date('2026-10-30T10:00:00Z'),
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('Routes de la liaison GestStock', () => {
  const saved: Record<string, string | undefined> = {};
  const sensitive: string[] = [];
  const output: string[] = [];
  const bodies: string[] = [];
  const links = new GeststockLinkRepository();
  const requests = new GeststockAuthorizationRequestRepository();

  function remember(value: string): string {
    if (value.length > 0) sensitive.push(value);
    return value;
  }

  /** Boutique approuvée (isActive), non bannie. */
  async function shop(name = 'Boutique Awa'): Promise<TestShop> {
    const created = await createShop(name, phone());
    await User.updateOne({ _id: created.id }, { isActive: true });
    return created;
  }

  async function call(handler: (req: Request) => Promise<Response>, url: string, body?: unknown, auth?: string): Promise<{ status: number; json: Record<string, any>; headers: Headers }> {
    const response = await handler(jsonRequest(url, body, { token: auth, method: body === undefined && url.endsWith('/link') ? 'GET' : 'POST' }));
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, json: text ? JSON.parse(text) : {}, headers: response.headers };
  }

  const startLink = (t?: string) => call(start, '/api/integrations/geststock/start', {}, t);
  const completeLink = (t: string | undefined, body: unknown) => call(complete, '/api/integrations/geststock/complete', body, t);
  const readLink = (t?: string) => call(getLink, '/api/integrations/geststock/link', undefined, t);
  const revokeLink = (t?: string, body: unknown = {}) => call(revoke, '/api/integrations/geststock/revoke', body, t);

  /** Demande en cours enregistrée par la route de démarrage (client simulé) ; rend le state et le vérificateur. */
  async function started(s: TestShop): Promise<{ state: string; codeVerifier: string }> {
    const state = remember(token());
    const codeVerifier = remember(token());
    vi.spyOn(geststockClient, 'startAuthorization').mockResolvedValueOnce({
      state,
      codeVerifier,
      requestUri: 'urn:ietf:params:oauth:request_uri:Zx9',
      expiresIn: 600,
      authorizationUrl: AUTHORIZE,
    });
    expect((await startLink(s.token)).status).toBe(201);
    return { state, codeVerifier };
  }

  /** Liaison terminée avec succès ; rend l'identifiant et le secret remis par GestStock (simulé). */
  async function linked(s: TestShop): Promise<{ linkId: string; secret: string }> {
    const { state } = await started(s);
    const link = remote(s.id);
    const secret = remember(token());
    vi.spyOn(geststockClient, 'exchangeCode').mockResolvedValueOnce({ linkId: link.linkId, linkSecret: secret, link });
    const done = await completeLink(s.token, { code: remember(token()), state, iss: 'geststock-integration' });
    expect(done.status).toBe(201);
    return { linkId: link.linkId, secret };
  }

  beforeEach(() => {
    for (const name of VARIABLES) saved[name] = process.env[name];
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.GESTSTOCK_LINK_ENCRYPTION_KEY_ID = 'k-test';
    process.env.GESTSTOCK_API_ORIGIN = 'https://api.geststock.test';
    process.env.GESTSTOCK_FRONTEND_ORIGIN = 'https://app.geststock.test';
    process.env.GESTSTOCK_CLIENT_ID = 'jcmb';
    process.env.GESTSTOCK_CLIENT_SECRET = remember(token());
    process.env.GESTSTOCK_REDIRECT_URI = REDIRECT_URI;
    sensitive.length = 0;
    output.length = 0;
    bodies.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
      });
    }
    // Aucun appel réseau réel : tout passe par le client simulé.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('appel réseau interdit dans les tests'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    const texts = [...output, ...bodies].join('\n');
    for (const value of sensitive) expect(texts).not.toContain(value);
  });

  // --- Accès ------------------------------------------------------------------------------------------

  it('non authentifié : 401, aucun appel à GestStock', async () => {
    const spy = vi.spyOn(geststockClient, 'startAuthorization');
    for (const response of [await startLink(), await readLink(), await revokeLink(), await completeLink(undefined, {})]) {
      expect(response.status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('administrateur : 403 ADMIN_FORBIDDEN', async () => {
    const s = await shop();
    await User.updateOne({ _id: s.id }, { role: 'admin' });
    const admin = signToken({ userId: s.id, phone: '0', role: 'admin', slug: s.slug, tokenVersion: 0 });
    for (const response of [await startLink(admin), await readLink(admin), await revokeLink(admin)]) {
      expect(response.status).toBe(403);
      expect(response.json.code).toBe('ADMIN_FORBIDDEN');
    }
  });

  it('boutique non approuvée : démarrer et terminer refusés (SHOP_NOT_ELIGIBLE) ; consulter et révoquer permis', async () => {
    const s = await shop();
    await User.updateOne({ _id: s.id }, { isActive: false });
    const refused = await startLink(s.token);
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('SHOP_NOT_ELIGIBLE');
    expect((await completeLink(s.token, { code: token(), state: token(), iss: 'geststock-integration' })).json.code).toBe('SHOP_NOT_ELIGIBLE');
    expect((await readLink(s.token)).status).toBe(200);
    expect((await revokeLink(s.token)).status).toBe(200);
  });

  it('boutique bannie : refusée dès l’authentification (401), comme toute route', async () => {
    const s = await shop();
    await User.updateOne({ _id: s.id }, { banned: true });
    for (const response of [await startLink(s.token), await readLink(s.token), await revokeLink(s.token)]) {
      expect(response.status).toBe(401);
    }
  });

  it('interrupteur désactivé : 404 INTEGRATION_DISABLED partout, aucun appel', async () => {
    const s = await shop();
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;
    const spy = vi.spyOn(geststockClient, 'startAuthorization');
    for (const response of [await startLink(s.token), await readLink(s.token), await revokeLink(s.token), await completeLink(s.token, {})]) {
      expect(response.status).toBe(404);
      expect(response.json.code).toBe('INTEGRATION_DISABLED');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('limiteur saturé : 429 RATE_LIMITED avec Retry-After', async () => {
    const s = await shop();
    vi.spyOn(geststockClient, 'startAuthorization').mockImplementation(async () => ({
      state: token(),
      codeVerifier: token(),
      requestUri: 'urn:ietf:params:oauth:request_uri:R',
      expiresIn: 600,
      authorizationUrl: AUTHORIZE,
    }));
    let last = await readLink(s.token);
    for (let i = 0; i < 40 && last.status !== 429; i++) last = await readLink(s.token);
    expect(last.status).toBe(429);
    expect(last.json.code).toBe('RATE_LIMITED');
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('limiteur indisponible : 503 RATE_LIMIT_UNAVAILABLE, jamais laissé passer', async () => {
    const s = await shop();
    const spy = vi.spyOn(geststockClient, 'startAuthorization');
    vi.spyOn(RateLimit, 'findOneAndUpdate').mockImplementation(() => {
      throw new Error('base indisponible');
    });
    const response = await startLink(s.token);
    expect(response.status).toBe(503);
    expect(response.json.code).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(spy).not.toHaveBeenCalled();
  });

  // --- Démarrer -----------------------------------------------------------------------------------------

  it('démarrer : authorizationUrl seulement ; demande enregistrée conforme à J2', async () => {
    const s = await shop('Boutique <b>Awa</b>');
    const state = remember(token());
    const codeVerifier = remember(token());
    const spy = vi.spyOn(geststockClient, 'startAuthorization').mockResolvedValueOnce({
      state,
      codeVerifier,
      requestUri: 'urn:ietf:params:oauth:request_uri:Zx9',
      expiresIn: 300,
      authorizationUrl: AUTHORIZE,
    });
    const before = Date.now();
    const response = await startLink(s.token);
    expect(response.status).toBe(201);
    expect(response.json.data).toEqual({ authorizationUrl: AUTHORIZE });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ shopId: s.id, shopName: 'Boutique <b>Awa</b>' }));

    const stored = await mongoose.connection.collection('geststockauthorizationrequests').findOne({ shopId: new mongoose.Types.ObjectId(s.id) });
    expect(stored?.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(stored?.requestUri).toBe('urn:ietf:params:oauth:request_uri:Zx9');
    expect(stored?.redirectUri).toBe(REDIRECT_URI);
    // Expiration : la plus courte entre 10 min et expires_in (300 s).
    const lifetime = (stored?.expiresAt as Date).getTime() - before;
    expect(lifetime).toBeGreaterThan(290_000);
    expect(lifetime).toBeLessThanOrEqual(301_000);
    expect(JSON.stringify(stored)).not.toContain(codeVerifier);
  });

  it('démarrer : 409 ALREADY_LINKED si une liaison non révoquée existe, sans appel à GestStock', async () => {
    const s = await shop();
    await linked(s);
    const spy = vi.spyOn(geststockClient, 'startAuthorization');
    const response = await startLink(s.token);
    expect(response.status).toBe(409);
    expect(response.json.code).toBe('ALREADY_LINKED');
    expect(spy).not.toHaveBeenCalled();
  });

  it('démarrer : au plus 3 demandes en cours par boutique', async () => {
    const s = await shop();
    for (let i = 0; i < 3; i++) await started(s);
    const spy = vi.spyOn(geststockClient, 'startAuthorization');
    const response = await startLink(s.token);
    expect(response.status).toBe(429);
    expect(response.json.code).toBe('TOO_MANY_PENDING_REQUESTS');
    expect(spy).not.toHaveBeenCalled();
  });

  it('démarrer : GestStock indisponible → 503 GESTSTOCK_UNAVAILABLE, aucune demande enregistrée', async () => {
    const s = await shop();
    vi.spyOn(geststockClient, 'startAuthorization').mockRejectedValueOnce(new GeststockError('UNAVAILABLE', { status: 503 }));
    const response = await startLink(s.token);
    expect(response.status).toBe(503);
    expect(response.json.code).toBe('GESTSTOCK_UNAVAILABLE');
    expect(await GeststockAuthorizationRequest.countDocuments({ shopId: s.id })).toBe(0);
  });

  // --- Terminer ------------------------------------------------------------------------------------------

  it('terminer : succès → liaison ACTIVE, secret chiffré avec les bonnes AAD, absent de la réponse', async () => {
    const s = await shop();
    const { state, codeVerifier } = await started(s);
    const link = remote(s.id);
    const secret = remember(token());
    const code = remember(token());
    const exchange = vi.spyOn(geststockClient, 'exchangeCode').mockResolvedValueOnce({ linkId: link.linkId, linkSecret: secret, link });
    const response = await completeLink(s.token, { code, state, iss: 'geststock-integration' });
    expect(response.status).toBe(201);
    expect(exchange).toHaveBeenCalledWith({ code, codeVerifier, iss: 'geststock-integration' });
    expect(response.json.data.link).toMatchObject({ status: 'ACTIVE', companyCode: 'optique-principale', companyName: null });
    // Vue de l'écran : statut, entreprise, motifs et dates seulement (v14-D1 étape 5).
    expect(Object.keys(response.json.data.link).sort()).toEqual(
      ['companyCode', 'companyName', 'lastStateSyncAt', 'linkedAt', 'revocationReason', 'revokedAt', 'status', 'suspensionReason']
    );
    expect(JSON.stringify(response.json)).not.toMatch(/ecret|ncrypted/);

    const stored = await mongoose.connection.collection('geststocklinks').findOne({ linkId: link.linkId });
    remember(String(stored?.encryptedSecret));
    expect(decryptLinkSecret(String(stored?.encryptedSecret), { linkId: link.linkId, shopId: s.id })).toBe(secret);
    expect(() => decryptLinkSecret(String(stored?.encryptedSecret), { linkId: randomUUID(), shopId: s.id })).toThrow();
  });

  it.each([
    ['state inconnu', async () => ({ state: token() })],
    ['state d’une autre boutique', async () => ({ state: (await started(await shop('Autre boutique'))).state })],
  ])('terminer : %s → 400 AUTHORIZATION_REQUEST_INVALID, aucun appel', async (_label, prepare) => {
    const s = await shop();
    const { state } = await prepare();
    const exchange = vi.spyOn(geststockClient, 'exchangeCode');
    const response = await completeLink(s.token, { code: token(), state: remember(state), iss: 'geststock-integration' });
    expect(response.status).toBe(400);
    expect(response.json.code).toBe('AUTHORIZATION_REQUEST_INVALID');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('terminer : state déjà utilisé ou expiré → refus sans appel', async () => {
    const s = await shop();
    const { state } = await started(s);
    vi.spyOn(geststockClient, 'exchangeCode').mockRejectedValueOnce(new GeststockError('INVALID_GRANT', { status: 400 }));
    expect((await completeLink(s.token, { code: token(), state, iss: 'geststock-integration' })).json.code).toBe('AUTHORIZATION_REJECTED');
    const exchange = vi.spyOn(geststockClient, 'exchangeCode');
    expect((await completeLink(s.token, { code: token(), state, iss: 'geststock-integration' })).json.code).toBe('AUTHORIZATION_REQUEST_INVALID');
    expect(exchange).not.toHaveBeenCalled();

    const other = await started(s);
    await GeststockAuthorizationRequest.updateOne({ stateHash: createHash('sha256').update(other.state).digest('hex') }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await completeLink(s.token, { code: token(), state: other.state, iss: 'geststock-integration' })).json.code).toBe('AUTHORIZATION_REQUEST_INVALID');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('terminer : corps mal formé → 400 INVALID_REQUEST, demande non consommée', async () => {
    const s = await shop();
    const { state } = await started(s);
    for (const body of [{}, { code: token(), state }, { code: 'a b', state, iss: 'geststock-integration' }, { code: token(), state: 'court', iss: 'x' }]) {
      const response = await completeLink(s.token, body);
      expect(response.status).toBe(400);
      expect(response.json.code).toBe('INVALID_REQUEST');
    }
    expect(await requests.consume({ shopId: s.id, state })).not.toBeNull();
  });

  it('terminer : deux terminaisons simultanées → un seul échange', async () => {
    const s = await shop();
    const { state } = await started(s);
    const link = remote(s.id);
    const exchange = vi.spyOn(geststockClient, 'exchangeCode').mockResolvedValue({ linkId: link.linkId, linkSecret: remember(token()), link });
    const code = remember(token());
    const responses = await Promise.all([
      completeLink(s.token, { code, state, iss: 'geststock-integration' }),
      completeLink(s.token, { code, state, iss: 'geststock-integration' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new GeststockError('INVALID_ISSUER'), 400, 'INVALID_ISSUER'],
    [new GeststockError('INVALID_GRANT', { status: 400 }), 400, 'AUTHORIZATION_REJECTED'],
    [new GeststockError('LINK_REVOKED', { status: 400, code: 'LINK_REVOKED' }), 409, 'LINK_REVOKED'],
    [new GeststockError('RATE_LIMITED', { status: 429, retryAfterSeconds: 42 }), 429, 'GESTSTOCK_RATE_LIMITED'],
    [new GeststockError('UNAVAILABLE', { status: 503 }), 503, 'GESTSTOCK_UNAVAILABLE'],
    [new GeststockError('TIMEOUT'), 503, 'GESTSTOCK_UNAVAILABLE'],
    [new GeststockError('INVALID_CLIENT', { status: 401 }), 502, 'GESTSTOCK_ERROR'],
    [new GeststockError('PROTOCOL'), 502, 'GESTSTOCK_ERROR'],
  ])('terminer : %s → %s %s ; demande consommée, jamais réutilisée', async (error, status, code) => {
    const s = await shop();
    const { state } = await started(s);
    vi.spyOn(geststockClient, 'exchangeCode').mockRejectedValueOnce(error);
    const response = await completeLink(s.token, { code: token(), state, iss: 'geststock-integration' });
    expect(response.status).toBe(status);
    expect(response.json.code).toBe(code);
    if (code === 'GESTSTOCK_RATE_LIMITED') expect(response.headers.get('retry-after')).toBe('42');
    expect(await requests.consume({ shopId: s.id, state })).toBeNull();
    expect(await GeststockLink.countDocuments({ shopId: s.id })).toBe(0);
  });

  // --- Compensation ------------------------------------------------------------------------------------

  async function completeWithSaveFailure(s: TestShop, failure: () => Promise<void>, revokeOutcome: 'ok' | 'fail') {
    const { state } = await started(s);
    const link = remote(s.id);
    const secret = remember(token());
    vi.spyOn(geststockClient, 'exchangeCode').mockResolvedValueOnce({ linkId: link.linkId, linkSecret: secret, link });
    await failure();
    const revokeSpy = vi.spyOn(geststockClient, 'revokeLink');
    if (revokeOutcome === 'ok') revokeSpy.mockResolvedValueOnce({ link: { ...link, status: 'REVOKED' }, alreadyRevoked: false });
    else revokeSpy.mockRejectedValueOnce(new GeststockError('UNAVAILABLE', { status: 503 }));
    const response = await completeLink(s.token, { code: remember(token()), state, iss: 'geststock-integration' });
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    const [credentials, reason] = revokeSpy.mock.calls[0];
    expect(credentials.linkId).toBe(link.linkId);
    expect(await credentials.secret()).toBe(secret);
    expect(reason).toContain('enregistr');
    return { response, linkId: link.linkId };
  }

  it.each(['ok', 'fail'] as const)('compensation : conflit d’unicité (liaison concurrente), révocation %s', async (outcome) => {
    const s = await shop();
    const { response, linkId } = await completeWithSaveFailure(
      s,
      async () => {
        // Une liaison concurrente s'enregistre entre l'échange et l'enregistrement.
        await links.createActiveLink({
          shopId: s.id,
          linkId: randomUUID(),
          companyCode: 'autre',
          currency: 'XOF',
          scopes: [],
          warehouses: [],
          linkedAt: new Date(),
          secret: remember(token()),
        });
      },
      outcome
    );
    expect(response.status).toBe(409);
    expect(response.json.code).toBe('ALREADY_LINKED');
    expect(await GeststockLink.countDocuments({ linkId })).toBe(0);
    const logs = output.join('\n');
    if (outcome === 'fail') {
      expect(logs).toContain(linkId);
      expect(logs).toContain('révoquer manuellement');
    }
  });

  it.each(['ok', 'fail'] as const)('compensation : erreur MongoDB à l’enregistrement, révocation %s', async (outcome) => {
    const s = await shop();
    const { response, linkId } = await completeWithSaveFailure(
      s,
      async () => {
        vi.spyOn(GeststockLink, 'create').mockRejectedValueOnce(new Error('MongoServerError: écriture impossible'));
      },
      outcome
    );
    expect(response.status).toBe(500);
    expect(response.json.code).toBe('LINK_SAVE_FAILED');
    expect(await GeststockLink.countDocuments({ linkId })).toBe(0);
    if (outcome === 'fail') expect(output.join('\n')).toContain(linkId);
  });

  it('compensation : liaison d’une autre boutique renvoyée par GestStock → révoquée, jamais enregistrée', async () => {
    const s = await shop();
    const { state } = await started(s);
    const link = remote(new mongoose.Types.ObjectId().toString());
    vi.spyOn(geststockClient, 'exchangeCode').mockResolvedValueOnce({ linkId: link.linkId, linkSecret: remember(token()), link });
    const revokeSpy = vi.spyOn(geststockClient, 'revokeLink').mockResolvedValueOnce({ link: null, alreadyRevoked: true });
    const response = await completeLink(s.token, { code: token(), state, iss: 'geststock-integration' });
    expect(response.status).toBe(502);
    expect(response.json.code).toBe('GESTSTOCK_ERROR');
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(await GeststockLink.countDocuments({ shopId: s.id })).toBe(0);
  });

  // --- Consulter ---------------------------------------------------------------------------------------

  it('consulter : aucune liaison → link null', async () => {
    const s = await shop();
    const response = await readLink(s.token);
    expect(response.status).toBe(200);
    expect(response.json.data).toEqual({ link: null, refreshed: false, stale: false });
  });

  it('consulter : état récent → pas de rafraîchissement ; ancien → GET /link et mise à jour', async () => {
    const s = await shop();
    const { linkId } = await linked(s);
    const spy = vi.spyOn(geststockClient, 'getLink');
    const fresh = await readLink(s.token);
    expect(fresh.json.data).toMatchObject({ refreshed: false, stale: false, link: { status: 'ACTIVE' } });
    expect(spy).not.toHaveBeenCalled();

    await GeststockLink.updateOne({ linkId }, { lastStateSyncAt: new Date(Date.now() - 5 * 60_000) });
    spy.mockResolvedValueOnce(remote(s.id, { linkId, status: 'SUSPENDED', suspensionReason: 'AUTHORIZER_LOST_ACCESS' }));
    const refreshed = await readLink(s.token);
    expect(refreshed.json.data).toMatchObject({ refreshed: true, stale: false, link: { status: 'SUSPENDED', suspensionReason: 'AUTHORIZER_LOST_ACCESS' } });
    const [credentials] = spy.mock.calls[0];
    expect(credentials.linkId).toBe(linkId);
  });

  it('consulter : LINK_REVOKED → liaison révoquée localement', async () => {
    const s = await shop();
    const { linkId } = await linked(s);
    await GeststockLink.updateOne({ linkId }, { lastStateSyncAt: null });
    vi.spyOn(geststockClient, 'getLink').mockRejectedValueOnce(new GeststockError('LINK_REVOKED', { status: 401, code: 'LINK_REVOKED' }));
    const response = await readLink(s.token);
    expect(response.json.data).toMatchObject({ refreshed: true, link: { status: 'REVOKED' } });
    expect(await links.findCurrentByShop(s.id)).toBeNull();
    expect(await links.revealSecret(s.id, linkId)).toBeNull();
  });

  it.each(['UNAVAILABLE', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED'] as const)(
    'consulter : GestStock %s → état local, « non actualisé », sans erreur',
    async (kind) => {
      const s = await shop();
      const { linkId } = await linked(s);
      await GeststockLink.updateOne({ linkId }, { lastStateSyncAt: null });
      vi.spyOn(geststockClient, 'getLink').mockRejectedValueOnce(new GeststockError(kind));
      const response = await readLink(s.token);
      expect(response.status).toBe(200);
      expect(response.json.data).toMatchObject({ refreshed: false, stale: true, link: { status: 'ACTIVE' } });
    }
  );

  // --- Révoquer ----------------------------------------------------------------------------------------

  it('révoquer : GestStock d’abord, puis révocation locale et jeton oublié', async () => {
    const s = await shop();
    const { linkId, secret } = await linked(s);
    let presented: string | undefined;
    const revokeSpy = vi.spyOn(geststockClient, 'revokeLink').mockImplementationOnce(async (credentials) => {
      // Secret lu au moment de l'appel : il est effacé ensuite par la révocation locale.
      presented = await credentials.secret();
      return { link: remote(s.id, { linkId, status: 'REVOKED', revocationReason: 'SHOP_REQUEST', revokedAt: new Date() }), alreadyRevoked: false };
    });
    const invalidate = vi.spyOn(geststockClient, 'invalidateLinkToken');
    const response = await revokeLink(s.token, { reason: 'Fermeture' });
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ revoked: true, link: { status: 'REVOKED', revocationReason: 'SHOP_REQUEST' } });
    const [credentials, reason] = revokeSpy.mock.calls[0];
    expect(credentials.linkId).toBe(linkId);
    expect(presented).toBe(secret);
    expect(reason).toBe('Fermeture');
    expect(invalidate).toHaveBeenCalledWith(linkId);
    const stored = await mongoose.connection.collection('geststocklinks').findOne({ linkId });
    expect(stored?.status).toBe('REVOKED');
    expect(stored?.encryptedSecret).toBeUndefined();
    expect(stored?.activeShopId).toBeUndefined();
  });

  it('révoquer : déjà révoquée chez GestStock → révocation locale', async () => {
    const s = await shop();
    const { linkId } = await linked(s);
    vi.spyOn(geststockClient, 'revokeLink').mockResolvedValueOnce({ link: null, alreadyRevoked: true });
    const response = await revokeLink(s.token);
    expect(response.json.data).toMatchObject({ revoked: true, link: { status: 'REVOKED' } });
  });

  it.each(['UNAVAILABLE', 'TIMEOUT', 'NETWORK'] as const)('révoquer : GestStock %s → 503 réessayable, aucune modification locale', async (kind) => {
    const s = await shop();
    const { linkId, secret } = await linked(s);
    vi.spyOn(geststockClient, 'revokeLink').mockRejectedValueOnce(new GeststockError(kind));
    const response = await revokeLink(s.token);
    expect(response.status).toBe(503);
    expect(response.json.code).toBe('GESTSTOCK_UNAVAILABLE');
    expect((await links.findCurrentByShop(s.id))?.status).toBe('ACTIVE');
    expect(await links.revealSecret(s.id, linkId)).toBe(secret);
  });

  it('révoquer : boutique sans liaison → 200, rien à révoquer, aucun appel', async () => {
    const s = await shop();
    const spy = vi.spyOn(geststockClient, 'revokeLink');
    const response = await revokeLink(s.token);
    expect(response.status).toBe(200);
    expect(response.json.data).toEqual({ link: null, revoked: false });
    expect(spy).not.toHaveBeenCalled();
  });

/**
   * Contraintes de GestStock sur POST /link/revoke (LinkController.LinkRevocationRequest) : champ `reason`,
   * facultatif, texte libre, 500 caractères au plus ; inscrit dans platform.integration_audit_log.reason
   * (varchar(500)), où PostgreSQL refuse le caractère NUL.
   */
  function respectsGeststockReason(reason: unknown): void {
    if (reason === undefined) return;
    expect(typeof reason).toBe('string');
    expect((reason as string).length).toBeGreaterThan(0);
    expect((reason as string).length).toBeLessThanOrEqual(500);
    expect(reason).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  }

  it('révoquer : motif de 500 caractères (après suppression des espaces) transmis tel quel, conforme à GestStock', async () => {
    const s = await shop();
    await linked(s);
    const spy = vi.spyOn(geststockClient, 'revokeLink').mockResolvedValueOnce({ link: null, alreadyRevoked: true });
    const reason = `Fermeture définitive. ${'é'.repeat(478)}`;
    expect(reason).toHaveLength(500);
    expect((await revokeLink(s.token, { reason: `  ${reason}\n` })).status).toBe(200);
    expect(spy.mock.calls[0][1]).toBe(reason);
    respectsGeststockReason(spy.mock.calls[0][1]);
  });

  it('révoquer : sans motif → aucun motif transmis', async () => {
    const s = await shop();
    await linked(s);
    const spy = vi.spyOn(geststockClient, 'revokeLink').mockResolvedValueOnce({ link: null, alreadyRevoked: true });
    expect((await revokeLink(s.token)).status).toBe(200);
    expect(spy.mock.calls[0][1]).toBeUndefined();
  });

  it.each([
    ['caractère NUL', 'Fermeture\u0000'],
    ['caractère de contrôle', 'Fermeture\u0007'],
    ['vide après suppression des espaces', '   '],
    ['non textuel', 42],
  ])('révoquer : motif invalide (%s) → 400 INVALID_REQUEST, aucun appel', async (_label, reason) => {
    const s = await shop();
    await linked(s);
    const spy = vi.spyOn(geststockClient, 'revokeLink');
    const response = await revokeLink(s.token, { reason });
    expect(response.status).toBe(400);
    expect(response.json.code).toBe('INVALID_REQUEST');
    expect(spy).not.toHaveBeenCalled();
  });

  it('compensation : motif constant conforme aux contraintes de GestStock', async () => {
    respectsGeststockReason(COMPENSATION_REASON);
  });

  it('révoquer : 400 de GestStock → 502 GESTSTOCK_REVOCATION_REJECTED, aucune modification locale', async () => {
    const s = await shop();
    const { linkId, secret } = await linked(s);
    vi.spyOn(geststockClient, 'revokeLink').mockRejectedValueOnce(new GeststockError('REJECTED', { status: 400, code: 'VALIDATION_FAILED' }));
    const response = await revokeLink(s.token, { reason: 'Fermeture' });
    expect(response.status).toBe(502);
    expect(response.json.code).toBe('GESTSTOCK_REVOCATION_REJECTED');
    expect((await links.findCurrentByShop(s.id))?.status).toBe('ACTIVE');
    expect(await links.revealSecret(s.id, linkId)).toBe(secret);
    expect(output.join('\n')).toContain(linkId);
  });

  it('révoquer : motif trop long → 400 INVALID_REQUEST, aucun appel', async () => {
    const s = await shop();
    await linked(s);
    const spy = vi.spyOn(geststockClient, 'revokeLink');
    const response = await revokeLink(s.token, { reason: 'x'.repeat(501) });
    expect(response.status).toBe(400);
    expect(response.json.code).toBe('INVALID_REQUEST');
    expect(spy).not.toHaveBeenCalled();
  });
});
