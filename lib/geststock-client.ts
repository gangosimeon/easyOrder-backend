import { createHash, randomBytes } from 'node:crypto';

import { IntegrationConfigError, isIntegrationEnabled } from '@/lib/integration-crypto';
import { Logger } from '@/lib/logger';

/**
 * Client HTTP de l'API d'intégration GestStock (intégration GestStock, lot 2, J3 ; v14-D1, v14-D3, v14-D4 ; contrat
 * `integration-v1` et code GestStock G8, G11, G14 qui fait foi).
 *
 * - **Démarrage** : `state` et vérificateur PKCE (32 octets aléatoires, base64url : 43 caractères, compatibles avec
 *   J2 et la RFC 7636), dépôt de la demande (`POST /oauth/par`, HTTP Basic), URL d'autorisation du frontend
 *   GestStock (`client_id` et `request_uri`).
 * - **Retour** : `iss` comparé exactement à l'émetteur attendu (RFC 9207), puis échange du code
 *   (`authorization_code`, `code_verifier`) ; liaison, secret de liaison et premier jeton rendus.
 * - **Jeton de liaison** (`client_credentials`) : en mémoire seulement, par liaison, jusqu'à l'expiration moins une
 *   minute, une seule requête pour des appels simultanés, invalidé sur un 401.
 * - **Liaison** : `GET /link`, `POST /link/revoke` (déjà révoquée : succès, comme le prévoit le contrat).
 *
 * Erreurs : {@link GeststockError} typée ({@link GeststockErrorKind}), message fixe ; jamais de secret, de jeton, de
 * code, de vérificateur, de `state` ni de `error_description` du serveur dans un message ou un journal. Chaque appel
 * a un délai (AbortController) ; les redirections ne sont jamais suivies.
 *
 * Réessais : seulement l'échange du code sur un 503 émis par GestStock avant toute consommation du code
 * (`temporarily_unavailable` du drapeau de publication, ou `RATE_LIMIT_UNAVAILABLE` du limiteur), au plus
 * {@link EXCHANGE_ATTEMPTS} tentatives (attentes de 0,5 puis 1 s). Jamais après un délai dépassé ni sur un 503 d'un
 * intermédiaire : le code a pu être consommé, et le rejouer révoquerait la liaison (v14-D14). Aucun réessai sur
 * 429 : `retryAfterSeconds` est rendu à l'appelant.
 */

export const GESTSTOCK_DEFAULT_ISSUER = 'geststock-integration';

/** Tentatives de l'échange du code sur un 503 sûr (la première comprise). */
export const EXCHANGE_ATTEMPTS = 3;

/** Attentes entre les tentatives de l'échange du code (ms). */
const EXCHANGE_BACKOFF_MS = [500, 1000];

/** Délai par défaut de chaque appel. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Marge avant l'expiration d'un jeton : renouvelé dans sa dernière minute. */
const TOKEN_MARGIN_MS = 60_000;

/** Longueur maximale conservée d'un motif (limite du modèle J2). */
const REASON_MAX_LENGTH = 64;

const API_PATH = '/api/integration/v1';
const AUTHORIZE_PATH = '/integrations/jecreemaboutique/authorize';
const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';
const LINK_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;

export type GeststockErrorKind =
  /** 401 invalid_client : identifiants du client JCMB refusés (configuration), aucun réessai. */
  | 'INVALID_CLIENT'
  /** 400 invalid_grant : code ou secret de liaison refusé. */
  | 'INVALID_GRANT'
  /** Liaison révoquée chez GestStock : à passer en REVOKED par l'appelant. */
  | 'LINK_REVOKED'
  /** `iss` du retour absent ou différent de l'émetteur attendu. */
  | 'INVALID_ISSUER'
  /** 429 : `retryAfterSeconds` rendu. */
  | 'RATE_LIMITED'
  /** 503 : GestStock ou un intermédiaire indisponible. */
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'REDIRECT'
  | 'NETWORK'
  /** Réponse inattendue : non JSON, mal formée, statut de liaison non pris en charge. */
  | 'PROTOCOL'
  /** Autre refus (400 invalid_request, 403, 404…) : `status` et `code` rendus. */
  | 'REJECTED';

const MESSAGES: Record<GeststockErrorKind, string> = {
  INVALID_CLIENT: 'GestStock refuse les identifiants du client JeCréeMaBoutique (configuration).',
  INVALID_GRANT: 'GestStock refuse l’autorisation (code ou secret de liaison invalide, expiré ou déjà utilisé).',
  LINK_REVOKED: 'La liaison GestStock est révoquée.',
  INVALID_ISSUER: 'Réponse d’autorisation d’un émetteur inattendu.',
  RATE_LIMITED: 'Trop de requêtes vers GestStock : réessayez plus tard.',
  UNAVAILABLE: 'GestStock est momentanément indisponible.',
  TIMEOUT: 'GestStock n’a pas répondu à temps.',
  REDIRECT: 'Redirection inattendue de GestStock, non suivie.',
  NETWORK: 'GestStock est injoignable.',
  PROTOCOL: 'Réponse inattendue de GestStock.',
  REJECTED: 'GestStock a refusé la requête.',
};

/** Erreur typée du client GestStock : message fixe, aucune valeur sensible. */
export class GeststockError extends Error {
  constructor(
    readonly kind: GeststockErrorKind,
    readonly details: { status?: number; code?: string; retryAfterSeconds?: number } = {}
  ) {
    super(MESSAGES[kind]);
    this.name = 'GeststockError';
  }
}

/** Dépôt vendable de la liaison, tel que renvoyé par GestStock. */
export interface RemoteLinkWarehouse {
  warehouseId: string;
  name: string;
  active: boolean;
  priority?: number;
}

/** Liaison telle que renvoyée par GestStock (`LinkView`), statut vérifié, motifs libres bornés. */
export interface RemoteLink {
  linkId: string;
  status: (typeof LINK_STATUSES)[number];
  suspensionReason: string | null;
  revocationReason: string | null;
  companyCode: string;
  /** Absent de `GET /link` et de l'échange chez GestStock : toujours `null` pour l'instant. */
  companyName: string | null;
  currency: string;
  externalShopId: string;
  scopes: string[];
  warehouses: RemoteLinkWarehouse[];
  createdAt: Date;
  lastSyncAt: Date | null;
  revokedAt: Date | null;
}

/** Démarrage d'une liaison : `state` et vérificateur à conserver (J2), URL à ouvrir dans le navigateur. */
export interface AuthorizationStart {
  state: string;
  codeVerifier: string;
  requestUri: string;
  expiresIn: number;
  authorizationUrl: string;
}

/** Résultat de l'échange du code : secret de liaison à chiffrer immédiatement (J2), jamais journalisé. */
export interface ExchangedLink {
  linkId: string;
  linkSecret: string;
  link: RemoteLink;
}

export interface LinkCredentials {
  linkId: string;
  /** Secret de liaison, lu seulement si un nouveau jeton est nécessaire (déchiffrement J2). */
  secret: () => Promise<string> | string;
}

export interface GeststockClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

interface ClientConfig {
  apiBase: string;
  frontendOrigin: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface HttpResult {
  status: number;
  headers: Headers;
  /** Corps JSON, ou `undefined` s'il n'est pas JSON. */
  body: unknown;
}

export class GeststockClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(options: GeststockClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // --- Démarrage -------------------------------------------------------------------------------------------

  /** Dépose la demande d'autorisation (PAR) pour la boutique ; rend le `state` et le vérificateur à conserver. */
  async startAuthorization(input: { shopId: string; shopName: string; scopes: string[] }): Promise<AuthorizationStart> {
    const config = clientConfig();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const result = await this.call(config, '/oauth/par', {
      method: 'POST',
      headers: clientHeaders(config),
      body: new URLSearchParams({
        response_type: 'code',
        redirect_uri: config.redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: input.scopes.join(' '),
        state,
        shop_id: input.shopId,
        shop_name: input.shopName,
      }).toString(),
    });
    if (result.status !== 201) throw oauthFailure(result, 'par');
    const body = result.body as { request_uri?: unknown; expires_in?: unknown } | undefined;
    if (typeof body?.request_uri !== 'string' || !body.request_uri.startsWith(REQUEST_URI_PREFIX) || !positiveInteger(body.expires_in)) {
      throw protocol('par');
    }
    const authorizationUrl = new URL(AUTHORIZE_PATH, config.frontendOrigin);
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('request_uri', body.request_uri);
    return { state, codeVerifier, requestUri: body.request_uri, expiresIn: body.expires_in, authorizationUrl: authorizationUrl.toString() };
  }

  // --- Retour --------------------------------------------------------------------------------------------

  /**
   * Retour de l'écran d'autorisation : `iss` d'abord (RFC 9207, comparaison exacte, aucun appel sinon), puis
   * échange du code. Le `state` est vérifié par l'appelant (J2) avant cet appel.
   */
  async exchangeCode(input: { code: string; codeVerifier: string; iss: string | null | undefined }): Promise<ExchangedLink> {
    const config = clientConfig();
    if (typeof input.iss !== 'string' || input.iss !== config.issuer) {
      Logger.warn('Retour d’autorisation GestStock refusé : émetteur absent ou inattendu.');
      throw new GeststockError('INVALID_ISSUER');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: input.codeVerifier,
    }).toString();
    for (let attempt = 1; ; attempt++) {
      const result = await this.call(config, '/oauth/token', { method: 'POST', headers: clientHeaders(config), body });
      if (result.status === 200) return this.exchanged(result.body);
      if (result.status === 503 && retryableUnavailable(result.body) && attempt < EXCHANGE_ATTEMPTS) {
        Logger.warn(`Échange du code GestStock : indisponible (tentative ${attempt}/${EXCHANGE_ATTEMPTS}), nouvel essai.`);
        await this.sleep(EXCHANGE_BACKOFF_MS[attempt - 1]);
        continue;
      }
      throw oauthFailure(result, 'échange du code');
    }
  }

  private exchanged(raw: unknown): ExchangedLink {
    const body = raw as { link?: unknown; link_secret?: unknown } | undefined;
    const token = tokenFrom(raw, 'échange du code');
    if (typeof body?.link_secret !== 'string' || body.link_secret.length === 0) throw protocol('échange du code');
    const link = remoteLink(body.link, 'échange du code');
    this.tokens.set(link.linkId, { value: token.value, expiresAt: this.now() + token.expiresIn * 1000 });
    return { linkId: link.linkId, linkSecret: body.link_secret, link };
  }

  // --- Jeton de liaison ----------------------------------------------------------------------------------

  /** Jeton de la liaison : en cache s'il reste plus d'une minute, sinon une seule requête partagée. */
  async getLinkAccessToken(credentials: LinkCredentials): Promise<string> {
    const cached = this.tokens.get(credentials.linkId);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.value;
    const pending = this.inflight.get(credentials.linkId);
    if (pending) return pending;
    const request = this.fetchToken(credentials).finally(() => this.inflight.delete(credentials.linkId));
    this.inflight.set(credentials.linkId, request);
    return request;
  }

  /** Oublie le jeton de la liaison (401, révocation). */
  invalidateLinkToken(linkId: string): void {
    this.tokens.delete(linkId);
  }

  private async fetchToken(credentials: LinkCredentials): Promise<string> {
    const config = clientConfig();
    const secret = await credentials.secret();
    const result = await this.call(config, '/oauth/token', {
      method: 'POST',
      headers: clientHeaders(config),
      body: new URLSearchParams({ grant_type: 'client_credentials', link_id: credentials.linkId, link_secret: secret }).toString(),
    });
    if (result.status !== 200) throw oauthFailure(result, 'jeton de liaison', credentials.linkId);
    const token = tokenFrom(result.body, 'jeton de liaison');
    this.tokens.set(credentials.linkId, { value: token.value, expiresAt: this.now() + token.expiresIn * 1000 });
    return token.value;
  }

  // --- Liaison -------------------------------------------------------------------------------------------

  /** État de la liaison chez GestStock (`GET /link`). */
  async getLink(credentials: LinkCredentials): Promise<RemoteLink> {
    const result = await this.withLinkToken(credentials, (token) => ({ method: 'GET', headers: bearer(token) }), '/link');
    if (result.status !== 200) throw linkFailure(result, credentials.linkId, this);
    return remoteLink(result.body, 'GET /link');
  }

  /**
   * Révocation par la boutique (`POST /link/revoke`, motif facultatif). Liaison déjà révoquée (401 LINK_REVOKED) :
   * succès, comme le prévoit le contrat. Le jeton de la liaison est oublié dans les deux cas.
   */
  async revokeLink(credentials: LinkCredentials, reason?: string): Promise<{ link: RemoteLink | null; alreadyRevoked: boolean }> {
    const result = await this.withLinkToken(
      credentials,
      (token) => ({
        method: 'POST',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify(reason === undefined ? {} : { reason }),
      }),
      '/link/revoke'
    );
    if (result.status === 401 && errorCode(result.body) === 'LINK_REVOKED') {
      this.invalidateLinkToken(credentials.linkId);
      return { link: null, alreadyRevoked: true };
    }
    if (result.status !== 200) throw linkFailure(result, credentials.linkId, this);
    this.invalidateLinkToken(credentials.linkId);
    return { link: remoteLink(result.body, 'POST /link/revoke'), alreadyRevoked: false };
  }

  /** Appel avec le jeton de la liaison ; un 401 INVALID_TOKEN l'invalide et l'appel est refait une seule fois. */
  private async withLinkToken(credentials: LinkCredentials, init: (token: string) => RequestInit, path: string): Promise<HttpResult> {
    const config = clientConfig();
    let result = await this.call(config, path, init(await this.getLinkAccessToken(credentials)));
    if (result.status === 401 && errorCode(result.body) === 'INVALID_TOKEN') {
      this.invalidateLinkToken(credentials.linkId);
      result = await this.call(config, path, init(await this.getLinkAccessToken(credentials)));
    }
    if (result.status === 401) this.invalidateLinkToken(credentials.linkId);
    return result;
  }

  // --- Transport -----------------------------------------------------------------------------------------

  /** Un appel : délai, redirection refusée, corps JSON lu si annoncé. */
  private async call(config: ClientConfig, path: string, init: RequestInit): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${config.apiBase}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted || (error as { name?: string })?.name === 'AbortError';
      Logger.warn(`Appel GestStock ${path} : ${aborted ? 'délai dépassé' : 'injoignable'}.`);
      throw new GeststockError(aborted ? 'TIMEOUT' : 'NETWORK');
    }
    try {
      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        Logger.warn(`Appel GestStock ${path} : redirection refusée (${response.status}).`);
        throw new GeststockError('REDIRECT', { status: response.status });
      }
      const contentType = response.headers.get('content-type') ?? '';
      let body: unknown;
      if (/^application\/(?:problem\+)?json\b/i.test(contentType)) {
        try {
          body = await response.json();
        } catch {
          if (response.ok) throw protocol(path);
        }
      }
      if (response.ok && (body === undefined || body === null || typeof body !== 'object')) throw protocol(path);
      return { status: response.status, headers: response.headers, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Configuration ---------------------------------------------------------------------------------------

/** Configuration du client, validée à chaque appel (première utilisation, comme J1) ; refus nommant la variable. */
function clientConfig(): ClientConfig {
  if (!isIntegrationEnabled()) {
    throw new IntegrationConfigError('Intégration GestStock désactivée (GESTSTOCK_INTEGRATION_ENABLED).');
  }
  const apiOrigin = origin('GESTSTOCK_API_ORIGIN');
  const frontendOrigin = origin('GESTSTOCK_FRONTEND_ORIGIN');
  const redirectUri = secureUrl('GESTSTOCK_REDIRECT_URI').toString();
  const clientId = required('GESTSTOCK_CLIENT_ID');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) {
    throw new IntegrationConfigError('GESTSTOCK_CLIENT_ID est mal formée.');
  }
  const clientSecret = required('GESTSTOCK_CLIENT_SECRET');
  const issuer = process.env.GESTSTOCK_ISSUER?.trim() || GESTSTOCK_DEFAULT_ISSUER;
  return { apiBase: `${apiOrigin}${API_PATH}`, frontendOrigin, clientId, clientSecret, redirectUri, issuer };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new IntegrationConfigError(`${name} est absente.`);
  return value;
}

/** URL https (http seulement pour localhost hors production), sans identifiants. */
function secureUrl(name: string): URL {
  let url: URL;
  try {
    url = new URL(required(name));
  } catch (error) {
    if (error instanceof IntegrationConfigError) throw error;
    throw new IntegrationConfigError(`${name} n’est pas une URL valide.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.NODE_ENV !== 'production';
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new IntegrationConfigError(`${name} doit être une URL https (http seulement pour localhost hors production).`);
  }
  return url;
}

function origin(name: string): string {
  const url = secureUrl(name);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new IntegrationConfigError(`${name} doit être une origine (schéma, hôte et port seulement).`);
  }
  return url.origin;
}

/** HTTP Basic du client (RFC 6749 § 2.3.1 : identifiant et secret encodés, décodés par GestStock). */
function clientHeaders(config: ClientConfig): Record<string, string> {
  const credentials = `${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`;
  return {
    authorization: `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
}

function formEncode(value: string): string {
  return encodeURIComponent(value);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// --- Réponses ------------------------------------------------------------------------------------------------

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function protocol(context: string): GeststockError {
  Logger.warn(`Réponse inattendue de GestStock (${context}).`);
  return new GeststockError('PROTOCOL');
}

function tokenFrom(raw: unknown, context: string): { value: string; expiresIn: number } {
  const body = raw as { access_token?: unknown; token_type?: unknown; expires_in?: unknown } | undefined;
  if (typeof body?.access_token !== 'string' || body.access_token.length === 0 || body.token_type !== 'Bearer' || !positiveInteger(body.expires_in)) {
    throw protocol(context);
  }
  return { value: body.access_token, expiresIn: body.expires_in };
}

function errorCode(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

function oauthErrorName(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' && /^[a-z_]{1,64}$/.test(error) ? error : undefined;
}

/** 503 émis par GestStock avant tout traitement du code : réessai sûr. */
function retryableUnavailable(body: unknown): boolean {
  return oauthErrorName(body) === 'temporarily_unavailable' || errorCode(body) === 'RATE_LIMIT_UNAVAILABLE';
}

function retryAfter(headers: Headers, now: number): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

/** Échec d'une route OAuth (`/oauth/par`, `/oauth/token`). */
function oauthFailure(result: HttpResult, context: string, linkId?: string): GeststockError {
  const error = oauthErrorName(result.body);
  const code = errorCode(result.body);
  const details = { status: result.status, ...(code ? { code } : {}) };
  let failure: GeststockError;
  if (result.status === 401 && error === 'invalid_client') failure = new GeststockError('INVALID_CLIENT', details);
  else if (result.status === 400 && error === 'invalid_grant') {
    failure = new GeststockError(code === 'LINK_REVOKED' ? 'LINK_REVOKED' : 'INVALID_GRANT', details);
  } else if (result.status === 429) {
    failure = new GeststockError('RATE_LIMITED', { ...details, retryAfterSeconds: retryAfter(result.headers, Date.now()) });
  } else if (result.status === 503) failure = new GeststockError('UNAVAILABLE', details);
  else if (result.status >= 400 && result.status < 500) failure = new GeststockError('REJECTED', { ...details, ...(error ? { code: code ?? error } : {}) });
  else if (result.status >= 500) failure = new GeststockError('UNAVAILABLE', details);
  else failure = new GeststockError('PROTOCOL', details);
  Logger.warn(`Appel GestStock (${context}) refusé : ${failure.kind} (${result.status}${error ? `, ${error}` : ''}${code ? `, ${code}` : ''})${linkId ? `, liaison ${linkId}` : ''}.`);
  return failure;
}

/** Échec d'une route de liaison (`ApiError`). */
function linkFailure(result: HttpResult, linkId: string, client: GeststockClient): GeststockError {
  const code = errorCode(result.body);
  const details = { status: result.status, ...(code ? { code } : {}) };
  let failure: GeststockError;
  if (code === 'LINK_REVOKED') {
    client.invalidateLinkToken(linkId);
    failure = new GeststockError('LINK_REVOKED', details);
  } else if (result.status === 429) {
    failure = new GeststockError('RATE_LIMITED', { ...details, retryAfterSeconds: retryAfter(result.headers, Date.now()) });
  } else if (result.status >= 500) failure = new GeststockError('UNAVAILABLE', details);
  else failure = new GeststockError(result.status >= 400 ? 'REJECTED' : 'PROTOCOL', details);
  Logger.warn(`Appel GestStock de la liaison ${linkId} refusé : ${failure.kind} (${result.status}${code ? `, ${code}` : ''}).`);
  return failure;
}

/** Liaison renvoyée par GestStock : statut ACTIVE, SUSPENDED ou REVOKED seulement ; motifs bornés, jamais refusés. */
function remoteLink(raw: unknown, context: string): RemoteLink {
  const view = raw as Record<string, unknown> | undefined;
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const date = (value: unknown): Date | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw protocol(context);
    return parsed;
  };
  if (!view || typeof view !== 'object' || !text(view.id) || !text(view.companyCode) || !text(view.currency) || !text(view.externalShopId)) {
    throw protocol(context);
  }
  if (!LINK_STATUSES.includes(view.status as (typeof LINK_STATUSES)[number])) throw protocol(`${context}, statut non pris en charge`);
  if (!Array.isArray(view.scopes) || !view.scopes.every((s) => typeof s === 'string') || !Array.isArray(view.warehouses)) {
    throw protocol(context);
  }
  const warehouses = view.warehouses.map((w): RemoteLinkWarehouse => {
    const warehouse = w as Record<string, unknown>;
    if (!text(warehouse.warehouseId) || !text(warehouse.name) || typeof warehouse.active !== 'boolean') throw protocol(context);
    return {
      warehouseId: warehouse.warehouseId,
      name: warehouse.name,
      active: warehouse.active,
      ...(typeof warehouse.priority === 'number' ? { priority: warehouse.priority } : {}),
    };
  });
  const createdAt = date(view.createdAt);
  if (!createdAt) throw protocol(context);
  return {
    linkId: view.id,
    status: view.status as RemoteLink['status'],
    suspensionReason: reason(view.suspensionReason),
    revocationReason: reason(view.revocationReason),
    companyCode: view.companyCode,
    companyName: text(view.companyName) ? view.companyName : null,
    currency: view.currency,
    externalShopId: view.externalShopId,
    scopes: [...view.scopes],
    warehouses,
    createdAt,
    lastSyncAt: date(view.lastSyncAt),
    revokedAt: date(view.revokedAt),
  };
}

/** Motif libre, tel que reçu (valeur inconnue tolérée), borné à la limite du modèle J2 sans jamais échouer. */
function reason(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, REASON_MAX_LENGTH) : null;
}
