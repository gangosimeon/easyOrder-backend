import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeststockClient, GeststockError, LinkCredentials } from '@/lib/geststock-client';
import { IntegrationConfigError } from '@/lib/integration-crypto';

/**
 * Client HTTP GestStock (lot 2, J3 ; v14-D1, v14-D3, contrat et code GestStock G8, G11) : PAR, échange du code
 * (iss RFC 9207, PKCE S256), jeton de liaison en mémoire, GET /link, révocation, erreurs typées. fetch simulé :
 * aucun appel réseau réel.
 */

const API = 'https://api.geststock.test';
const FRONT = 'https://app.geststock.test';
const BASE = `${API}/api/integration/v1`;
const REDIRECT_URI = 'https://www.jecreemaboutique.com/integrations/geststock/callback';
const CLIENT_ID = 'jcmb-test';

const VARIABLES = [
  'GESTSTOCK_INTEGRATION_ENABLED',
  'GESTSTOCK_API_ORIGIN',
  'GESTSTOCK_FRONTEND_ORIGIN',
  'GESTSTOCK_CLIENT_ID',
  'GESTSTOCK_CLIENT_SECRET',
  'GESTSTOCK_REDIRECT_URI',
  'GESTSTOCK_ISSUER',
  'NODE_ENV',
] as const;

type FetchMock = ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function problem(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'urn:geststock:error', title: 'Erreur', status, code, message: 'Refus.' }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

function oauthError(status: number, error: string, code?: string): Response {
  return json(status, { error, error_description: 'Description du serveur.', ...(code ? { code } : {}) });
}

function linkView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? randomUUID(),
    status: 'ACTIVE',
    suspensionReason: null,
    revocationReason: null,
    companyCode: 'optique-principale',
    currency: 'XOF',
    externalShopId: '665f1b2c3d4e5f6a7b8c9d0e',
    scopes: ['catalog:read', 'stock:read'],
    warehouses: [{ warehouseId: randomUUID(), name: 'Magasin Plateau', active: true }],
    settings: {},
    createdAt: '2026-10-30T10:00:00Z',
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** process.env sans le typage en lecture seule de NODE_ENV (Next). */
const env = process.env as Record<string, string | undefined>;

function form(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init?.body)));
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('Client HTTP GestStock', () => {
  const saved: Record<string, string | undefined> = {};
  const sensitive: string[] = [];
  const output: string[] = [];
  const errors: unknown[] = [];
  let fetchMock: FetchMock;
  let clock: number;
  let sleeps: number[];
  let clientSecret: string;
  let client: GeststockClient;

  function remember(value: string): string {
    if (value.length > 0) sensitive.push(value);
    return value;
  }

  /** Erreur attendue, conservée pour vérifier qu'aucun message ne contient de valeur sensible. */
  async function failure(promise: Promise<unknown>): Promise<GeststockError> {
    try {
      await promise;
    } catch (error) {
      errors.push(error);
      expect(error).toBeInstanceOf(GeststockError);
      return error as GeststockError;
    }
    throw new Error('échec attendu');
  }

  function credentials(linkId = randomUUID(), secret = remember(randomBytes(32).toString('base64url'))): LinkCredentials & { provider: ReturnType<typeof vi.fn> } {
    const provider = vi.fn(async () => secret);
    return { linkId, secret: provider, provider };
  }

  function tokenResponse(expiresIn = 900): Response {
    return json(200, { access_token: remember(`jwt-${randomBytes(24).toString('base64url')}`), token_type: 'Bearer', expires_in: expiresIn, scope: 'catalog:read' });
  }

  beforeEach(() => {
    for (const name of VARIABLES) saved[name] = process.env[name];
    sensitive.length = 0;
    output.length = 0;
    errors.length = 0;
    clientSecret = remember(`${randomBytes(24).toString('base64url')}:%+/`);
    process.env.GESTSTOCK_INTEGRATION_ENABLED = 'true';
    process.env.GESTSTOCK_API_ORIGIN = API;
    process.env.GESTSTOCK_FRONTEND_ORIGIN = FRONT;
    process.env.GESTSTOCK_CLIENT_ID = CLIENT_ID;
    process.env.GESTSTOCK_CLIENT_SECRET = clientSecret;
    process.env.GESTSTOCK_REDIRECT_URI = REDIRECT_URI;
    delete process.env.GESTSTOCK_ISSUER;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
    }
    fetchMock = vi.fn();
    clock = Date.parse('2026-10-30T10:00:00Z');
    sleeps = [];
    client = new GeststockClient({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      timeoutMs: 50,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    // Aucun secret, jeton, code ni vérificateur dans les journaux ni dans les messages d'erreur.
    const basic = Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(clientSecret)}`).toString('base64');
    const texts = [...output, ...errors.map((e) => `${(e as Error).message} ${JSON.stringify(e)}`)].join('\n');
    for (const value of [...sensitive, basic]) expect(texts).not.toContain(value);
  });

  // --- Démarrage (PAR) ------------------------------------------------------------------------------------

  it('PAR : corps et en-têtes exacts (Basic, S256, redirect_uri) ; URL d’autorisation construite', async () => {
    const requestUri = 'urn:ietf:params:oauth:request_uri:Zx9-demande';
    fetchMock.mockResolvedValueOnce(json(201, { request_uri: requestUri, expires_in: 600 }));
    const start = await client.startAuthorization({ shopId: '665f1b2c3d4e5f6a7b8c9d0e', shopName: 'Boutique Awa & Co', scopes: ['catalog:read', 'stock:read'] });
    remember(start.state);
    remember(start.codeVerifier);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/oauth/par`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(header(init, 'content-type')).toBe('application/x-www-form-urlencoded');
    expect(header(init, 'accept')).toBe('application/json');
    const basic = Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(clientSecret)}`).toString('base64');
    expect(header(init, 'authorization')).toBe(`Basic ${basic}`);
    expect(form(init)).toEqual({
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge: createHash('sha256').update(start.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'catalog:read stock:read',
      state: start.state,
      shop_id: '665f1b2c3d4e5f6a7b8c9d0e',
      shop_name: 'Boutique Awa & Co',
    });
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.requestUri).toBe(requestUri);
    expect(start.expiresIn).toBe(600);
    const authorization = new URL(start.authorizationUrl);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(`${FRONT}/integrations/jecreemaboutique/authorize`);
    expect(Object.fromEntries(authorization.searchParams)).toEqual({ client_id: CLIENT_ID, request_uri: requestUri });
  });

  it('PAR : réponse sans request_uri valable → erreur de protocole', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { request_uri: 'https://ailleurs', expires_in: 600 }));
    expect((await failure(client.startAuthorization({ shopId: 's', shopName: 'n', scopes: ['catalog:read'] }))).kind).toBe('PROTOCOL');
  });

  // --- Retour (iss) et échange du code -----------------------------------------------------------------------

  it.each([undefined, null, '', 'geststock', 'https://api.geststock.test', 'GESTSTOCK-INTEGRATION', 'geststock-integration '])(
    'iss absent ou différent (%s) : refusé, aucun appel',
    async (iss) => {
      const error = await failure(client.exchangeCode({ code: remember('code-secret-1'), codeVerifier: remember('v'.repeat(43)), iss }));
      expect(error.kind).toBe('INVALID_ISSUER');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('échange : corps exact, liaison et secret rendus, jeton mis en cache', async () => {
    const code = remember(randomBytes(32).toString('base64url'));
    const verifier = remember(randomBytes(32).toString('base64url'));
    const linkSecret = remember(randomBytes(32).toString('base64url'));
    const view = linkView({ suspensionReason: null });
    const token = tokenResponse();
    fetchMock.mockResolvedValueOnce(
      json(200, { ...(await token.clone().json()), link: view, link_secret: linkSecret })
    );
    const exchanged = await client.exchangeCode({ code, codeVerifier: verifier, iss: 'geststock-integration' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/oauth/token`);
    expect(header(init, 'authorization')).toMatch(/^Basic /);
    expect(form(init)).toEqual({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
    expect(exchanged.linkId).toBe(view.id);
    expect(exchanged.linkSecret).toBe(linkSecret);
    expect(exchanged.link).toMatchObject({ linkId: view.id, status: 'ACTIVE', companyCode: 'optique-principale', companyName: null, currency: 'XOF' });
    expect(exchanged.link.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');

    // Le jeton rendu par l'échange sert aux appels suivants : aucun nouvel échange de jeton.
    const access = await client.getLinkAccessToken({ linkId: exchanged.linkId, secret: () => linkSecret });
    expect(access.startsWith('jwt-')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('échange : 503 temporarily_unavailable réessayé, au plus 3 tentatives, attente croissante', async () => {
    const view = linkView();
    fetchMock
      .mockResolvedValueOnce(oauthError(503, 'temporarily_unavailable'))
      .mockResolvedValueOnce(problem(503, 'RATE_LIMIT_UNAVAILABLE'))
      .mockResolvedValueOnce(json(200, { access_token: remember('jwt-a'), token_type: 'Bearer', expires_in: 900, scope: 'x', link: view, link_secret: remember('s'.repeat(43)) }));
    const exchanged = await client.exchangeCode({ code: remember('code-503'), codeVerifier: remember('w'.repeat(43)), iss: 'geststock-integration' });
    expect(exchanged.linkId).toBe(view.id);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('échange : 503 persistant → indisponible après exactement 3 tentatives', async () => {
    fetchMock.mockImplementation(async () => oauthError(503, 'temporarily_unavailable'));
    const error = await failure(client.exchangeCode({ code: remember('code-503b'), codeVerifier: remember('x'.repeat(43)), iss: 'geststock-integration' }));
    expect(error.kind).toBe('UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('échange : 503 d’un intermédiaire (corps non GestStock) → aucun réessai (le code a pu être consommé)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Service Unavailable</html>', { status: 503, headers: { 'content-type': 'text/html' } }));
    const error = await failure(client.exchangeCode({ code: remember('code-gw'), codeVerifier: remember('y'.repeat(43)), iss: 'geststock-integration' }));
    expect(error.kind).toBe('UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [oauthError(400, 'invalid_grant'), 'INVALID_GRANT'],
    [oauthError(401, 'invalid_client'), 'INVALID_CLIENT'],
    [oauthError(400, 'invalid_request'), 'REJECTED'],
  ])('échange : %#, aucun réessai', async (response, kind) => {
    fetchMock.mockResolvedValueOnce(response);
    const error = await failure(client.exchangeCode({ code: remember('code-x'), codeVerifier: remember('z'.repeat(43)), iss: 'geststock-integration' }));
    expect(error.kind).toBe(kind);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('échange : délai dépassé → aucun réessai (le code a pu être consommé)', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const error = await failure(client.exchangeCode({ code: remember('code-t'), codeVerifier: remember('t'.repeat(43)), iss: 'geststock-integration' }));
    expect(error.kind).toBe('TIMEOUT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // --- Jeton de liaison ------------------------------------------------------------------------------------

  it('jeton : client_credentials exact, réutilisé, renouvelé à l’expiration moins la marge', async () => {
    const link = credentials();
    fetchMock.mockResolvedValueOnce(tokenResponse(900)).mockResolvedValueOnce(tokenResponse(900));
    const first = await client.getLinkAccessToken(link);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/oauth/token`);
    expect(form(init)).toEqual({ grant_type: 'client_credentials', link_id: link.linkId, link_secret: await link.provider.mock.results[0].value });

    clock += 800_000; // 13 min 20 s : encore valable au-delà de la marge de 60 s
    expect(await client.getLinkAccessToken(link)).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 41_000; // dans la dernière minute : renouvelé
    const second = await client.getLinkAccessToken(link);
    expect(second).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('jeton : appels simultanés → une seule requête, secret lu une fois', async () => {
    const link = credentials();
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    const pending = [client.getLinkAccessToken(link), client.getLinkAccessToken(link), client.getLinkAccessToken(link)];
    await Promise.resolve();
    release(tokenResponse());
    const tokens = await Promise.all(pending);
    expect(new Set(tokens).size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(link.provider).toHaveBeenCalledTimes(1);
  });

  it('jeton : échec partagé par les appels simultanés, puis nouvelle tentative possible', async () => {
    const link = credentials();
    fetchMock.mockResolvedValueOnce(oauthError(400, 'invalid_grant')).mockResolvedValueOnce(tokenResponse());
    const results = await Promise.allSettled([client.getLinkAccessToken(link), client.getLinkAccessToken(link)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results) errors.push((r as PromiseRejectedResult).reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await client.getLinkAccessToken(link)).toMatch(/^jwt-/);
  });

  it('jeton : liaison révoquée (400 invalid_grant, code LINK_REVOKED) → LINK_REVOKED', async () => {
    fetchMock.mockResolvedValueOnce(oauthError(400, 'invalid_grant', 'LINK_REVOKED'));
    expect((await failure(client.getLinkAccessToken(credentials()))).kind).toBe('LINK_REVOKED');
  });

  it('jeton : 429 → Retry-After rendu, aucun réessai', async () => {
    fetchMock.mockResolvedValueOnce(problem(429, 'RATE_LIMITED', { 'retry-after': '17' }));
    const error = await failure(client.getLinkAccessToken(credentials()));
    expect(error.kind).toBe('RATE_LIMITED');
    expect(error.details.retryAfterSeconds).toBe(17);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('jeton : 401 invalid_client → erreur de configuration, aucun réessai', async () => {
    fetchMock.mockResolvedValueOnce(oauthError(401, 'invalid_client'));
    expect((await failure(client.getLinkAccessToken(credentials()))).kind).toBe('INVALID_CLIENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // --- Appels de liaison --------------------------------------------------------------------------------

  it('GET /link : jeton Bearer, liaison rendue (companyName null, motif inconnu toléré, motif long tronqué)', async () => {
    const link = credentials();
    const longReason = 'MOTIF_FUTUR_'.repeat(10);
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      json(200, linkView({ id: link.linkId, status: 'SUSPENDED', suspensionReason: longReason, warehouses: [{ warehouseId: 'w', name: 'Entrepôt', active: false, priority: 2 }] }))
    );
    const remote = await client.getLink(link);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(`${BASE}/link`);
    expect(init?.method).toBe('GET');
    expect(header(init, 'authorization')).toMatch(/^Bearer jwt-/);
    expect(remote.status).toBe('SUSPENDED');
    expect(remote.companyName).toBeNull();
    expect(remote.suspensionReason).toBe(longReason.slice(0, 64));
    expect(remote.warehouses).toEqual([{ warehouseId: 'w', name: 'Entrepôt', active: false, priority: 2 }]);
  });

  it.each(['PENDING', 'ARCHIVED', undefined])('GET /link : statut %s refusé', async (status) => {
    const link = credentials();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(200, linkView({ id: link.linkId, status })));
    expect((await failure(client.getLink(link))).kind).toBe('PROTOCOL');
  });

  it('GET /link : 401 INVALID_TOKEN → jeton invalidé, un seul nouvel essai avec un jeton neuf', async () => {
    const link = credentials();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(problem(401, 'INVALID_TOKEN'))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json(200, linkView({ id: link.linkId })));
    expect((await client.getLink(link)).linkId).toBe(link.linkId);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(header(fetchMock.mock.calls[1][1], 'authorization')).not.toBe(header(fetchMock.mock.calls[3][1], 'authorization'));
  });

  it('GET /link : 401 persistant → aucune boucle (deux jetons au plus)', async () => {
    const link = credentials();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(problem(401, 'INVALID_TOKEN'))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(problem(401, 'INVALID_TOKEN'));
    expect((await failure(client.getLink(link))).kind).toBe('REJECTED');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('GET /link : 401 LINK_REVOKED → LINK_REVOKED, jeton invalidé, aucun réessai', async () => {
    const link = credentials();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(problem(401, 'LINK_REVOKED')).mockResolvedValueOnce(tokenResponse());
    expect((await failure(client.getLink(link))).kind).toBe('LINK_REVOKED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.getLinkAccessToken(link);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('révocation : POST /link/revoke avec motif ; 401 LINK_REVOKED traité comme un succès', async () => {
    const link = credentials();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(200, linkView({ id: link.linkId, status: 'REVOKED', revocationReason: 'SHOP_REQUEST', revokedAt: '2026-10-30T11:00:00Z', warehouses: [] })));
    const revoked = await client.revokeLink(link, 'Fermeture de la boutique');
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(`${BASE}/link/revoke`);
    expect(init?.method).toBe('POST');
    expect(header(init, 'content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Fermeture de la boutique' });
    expect(revoked).toMatchObject({ alreadyRevoked: false, link: { status: 'REVOKED', revocationReason: 'SHOP_REQUEST' } });

    const again = credentials();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(problem(401, 'LINK_REVOKED'));
    expect(await client.revokeLink(again)).toEqual({ link: null, alreadyRevoked: true });
    // Sans motif : corps {} (LinkRevocationRequest.reason absent, donc null chez GestStock).
    expect(fetchMock.mock.calls[3][1]?.body).toBe('{}');
    expect(header(fetchMock.mock.calls[3][1], 'content-type')).toBe('application/json');
  });

  // --- Transport ------------------------------------------------------------------------------------------

  it('redirection : refusée, jamais suivie', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://ailleurs.example/' } }));
    expect((await failure(client.getLinkAccessToken(credentials()))).kind).toBe('REDIRECT');
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it.each([
    ['non JSON', new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['JSON mal formé', new Response('{"access_token":', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['champ manquant', json(200, { token_type: 'Bearer', expires_in: 900 })],
    ['durée invalide', json(200, { access_token: 'jwt-x', token_type: 'Bearer', expires_in: -5 })],
  ])('réponse %s → erreur de protocole', async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response);
    expect((await failure(client.getLinkAccessToken(credentials()))).kind).toBe('PROTOCOL');
  });

  it('délai dépassé : TIMEOUT', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    expect((await failure(client.getLinkAccessToken(credentials()))).kind).toBe('TIMEOUT');
  });

  it('erreur réseau : NETWORK', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await failure(client.getLinkAccessToken(credentials()))).kind).toBe('NETWORK');
  });

  // --- Configuration --------------------------------------------------------------------------------------

  it('intégration désactivée : refus explicite, aucun appel', async () => {
    delete process.env.GESTSTOCK_INTEGRATION_ENABLED;
    await expect(client.startAuthorization({ shopId: 's', shopName: 'n', scopes: ['catalog:read'] })).rejects.toBeInstanceOf(IntegrationConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['GESTSTOCK_CLIENT_SECRET', undefined],
    ['GESTSTOCK_CLIENT_ID', undefined],
    ['GESTSTOCK_API_ORIGIN', 'http://api.geststock.test'],
    ['GESTSTOCK_API_ORIGIN', 'pas une url'],
    ['GESTSTOCK_FRONTEND_ORIGIN', 'http://app.geststock.test'],
    ['GESTSTOCK_REDIRECT_URI', 'http://www.jecreemaboutique.com/callback'],
  ])('configuration : %s invalide (%s) → refus nommant la variable', async (variable, value) => {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
    let caught: unknown;
    try {
      await client.startAuthorization({ shopId: 's', shopName: 'n', scopes: ['catalog:read'] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationConfigError);
    expect((caught as Error).message).toContain(variable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('configuration : http://localhost accepté hors production seulement', async () => {
    process.env.GESTSTOCK_API_ORIGIN = 'http://localhost:8080';
    env.NODE_ENV = 'development';
    fetchMock.mockResolvedValueOnce(json(201, { request_uri: 'urn:ietf:params:oauth:request_uri:L', expires_in: 600 }));
    const start = await client.startAuthorization({ shopId: 's', shopName: 'n', scopes: ['catalog:read'] });
    remember(start.state);
    remember(start.codeVerifier);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8080/api/integration/v1/oauth/par');

    env.NODE_ENV = 'production';
    await expect(client.startAuthorization({ shopId: 's', shopName: 'n', scopes: ['catalog:read'] })).rejects.toBeInstanceOf(IntegrationConfigError);
  });
});
