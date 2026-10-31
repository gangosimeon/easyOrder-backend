import { GeststockClient, GeststockError, LinkCredentials, geststockRedirectUri } from '@/lib/geststock-client';
import { IntegrationConfigError, LinkSecretError } from '@/lib/integration-crypto';
import { Logger } from '@/lib/logger';
import { GeststockAuthorizationRequestRepository } from '@/repositories/geststock-authorization-request.repository';
import {
  GeststockLinkConflictError,
  GeststockLinkRepository,
  GeststockLinkView,
} from '@/repositories/geststock-link.repository';
import { CompleteGeststockLinkInput } from '@/validators/geststock.validator';

/**
 * Liaison GestStock de la boutique connectée (intégration GestStock, lot 2, J4 ; v14-D1, v14-D2, v14-D14) :
 * démarrer, terminer, consulter, révoquer. La boutique est toujours l'utilisateur connecté ; aucune valeur sensible
 * (secret, jeton, code, `state`, vérificateur) ne sort de ce module ni n'est journalisée.
 */

/** Client GestStock partagé par les routes (jeton de liaison en mémoire). */
export const geststockClient = new GeststockClient();

/** Demandes d'autorisation en cours (non consommées, non expirées) au plus, par boutique. */
export const MAX_PENDING_REQUESTS = 3;

/** Consultation : l'état est relu chez GestStock s'il date de plus d'une minute. */
export const LINK_REFRESH_AFTER_MS = 60_000;

/** Portées du contrat demandées à la liaison (C5) ; `GESTSTOCK_SCOPES` peut les restreindre. */
const CONTRACT_SCOPES = ['catalog:read', 'catalog:match', 'price:propose', 'stock:read', 'orders:read', 'orders:write'];

/**
 * Motif transmis à GestStock quand une liaison activée n'a pas pu être enregistrée ici : constant, conforme à
 * `LinkRevocationRequest.reason` (texte libre, 500 caractères au plus, sans caractère de contrôle). GestStock enregistre
 * la révocation en `SHOP_REQUEST` et inscrit ce texte à son journal d'audit.
 */
export const COMPENSATION_REASON = 'Liaison non enregistrée par JeCréeMaBoutique : révocation automatique.';

const linkRepository = new GeststockLinkRepository();
const requestRepository = new GeststockAuthorizationRequestRepository();

/**
 * Liaison telle que la voit l'écran de la boutique (Angular, JA1) : statut, entreprise, motifs et dates seulement
 * (v14-D1 étape 5). Ni identifiant de liaison, ni secret, ni champ technique.
 */
export interface ShopLinkView {
  status: GeststockLinkView['status'];
  companyCode: string;
  companyName: string | null;
  suspensionReason: string | null;
  revocationReason: string | null;
  linkedAt: Date;
  lastStateSyncAt: Date | null;
  revokedAt: Date | null;
}

function shopView(view: GeststockLinkView | null): ShopLinkView | null {
  if (!view) return null;
  return {
    status: view.status,
    companyCode: view.companyCode,
    companyName: view.companyName,
    suspensionReason: view.suspensionReason,
    revocationReason: view.revocationReason,
    linkedAt: view.linkedAt,
    lastStateSyncAt: view.lastStateSyncAt,
    revokedAt: view.revokedAt,
  };
}

/** Refus d'une route de la liaison : statut HTTP et code stable pour l'écran (JA1). */
export class GeststockRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'GeststockRouteError';
  }
}

// --- Démarrer ------------------------------------------------------------------------------------------

/** Dépose la demande chez GestStock et l'enregistre (J2) ; rend seulement l'URL de l'écran d'autorisation. */
export async function startGeststockLink(shop: { id: string; name: string }): Promise<{ authorizationUrl: string }> {
  if (await linkRepository.findCurrentByShop(shop.id)) {
    throw new GeststockRouteError(409, 'ALREADY_LINKED', 'Cette boutique est déjà liée à une entreprise GestStock.');
  }
  if ((await requestRepository.countPending(shop.id)) >= MAX_PENDING_REQUESTS) {
    throw new GeststockRouteError(429, 'TOO_MANY_PENDING_REQUESTS', 'Trop de demandes de liaison en cours : terminez-en une ou réessayez dans quelques minutes.');
  }
  let started;
  let redirectUri;
  try {
    redirectUri = geststockRedirectUri();
    started = await geststockClient.startAuthorization({ shopId: shop.id, shopName: shop.name, scopes: requestedScopes() });
  } catch (error) {
    throw fromGeststock(error, 'démarrage');
  }
  await requestRepository.create({
    shopId: shop.id,
    state: started.state,
    codeVerifier: started.codeVerifier,
    requestUri: started.requestUri,
    redirectUri,
    lifetimeMs: started.expiresIn * 1000,
  });
  Logger.info('Demande de liaison GestStock déposée.', { shopId: shop.id });
  return { authorizationUrl: started.authorizationUrl };
}

// --- Terminer ------------------------------------------------------------------------------------------

/**
 * Retour de l'écran d'autorisation : consommation de la demande (J2, une seule fois) AVANT tout appel, échange du
 * code, puis enregistrement de la liaison (secret chiffré, J1). Enregistrement impossible après un échange réussi :
 * la liaison est aussitôt révoquée chez GestStock (compensation).
 */
export async function completeGeststockLink(shopId: string, input: CompleteGeststockLinkInput): Promise<{ link: ShopLinkView | null }> {
  const request = await requestRepository.consume({ shopId, state: input.state });
  if (!request) {
    throw new GeststockRouteError(400, 'AUTHORIZATION_REQUEST_INVALID', 'Demande de liaison inconnue, expirée ou déjà utilisée : recommencez la liaison.');
  }
  let exchanged;
  try {
    exchanged = await geststockClient.exchangeCode({ code: input.code, codeVerifier: request.codeVerifier, iss: input.iss });
  } catch (error) {
    throw fromGeststock(error, 'échange du code');
  }
  if (exchanged.link.externalShopId !== shopId || exchanged.link.status !== 'ACTIVE') {
    Logger.error(`Liaison GestStock ${exchanged.linkId} inattendue à l'échange du code (boutique ou statut).`, { shopId });
    await compensate(shopId, exchanged.linkId, exchanged.linkSecret);
    throw new GeststockRouteError(502, 'GESTSTOCK_ERROR', 'Réponse inattendue de GestStock : la liaison n’a pas été créée.');
  }
  try {
    const link = await linkRepository.createActiveLink({
      shopId,
      linkId: exchanged.linkId,
      companyCode: exchanged.link.companyCode,
      companyName: exchanged.link.companyName,
      currency: exchanged.link.currency,
      scopes: exchanged.link.scopes,
      warehouses: exchanged.link.warehouses,
      linkedAt: new Date(),
      secret: exchanged.linkSecret,
    });
    return { link: shopView(link) };
  } catch (error) {
    Logger.error(`Liaison GestStock ${exchanged.linkId} non enregistrée (${(error as Error)?.name ?? 'erreur'}).`, { shopId });
    await compensate(shopId, exchanged.linkId, exchanged.linkSecret);
    if (error instanceof GeststockLinkConflictError) {
      throw new GeststockRouteError(409, 'ALREADY_LINKED', 'Cette boutique est déjà liée à une entreprise GestStock.');
    }
    throw new GeststockRouteError(500, 'LINK_SAVE_FAILED', 'La liaison n’a pas pu être enregistrée : recommencez la liaison.');
  }
}

/**
 * Révocation immédiate chez GestStock d'une liaison activée mais non enregistrée, avec le secret encore en mémoire.
 * Échec : identifiant de la liaison journalisé (jamais le secret), pour une révocation manuelle depuis GestStock.
 */
async function compensate(shopId: string, linkId: string, secret: string): Promise<void> {
  try {
    await geststockClient.revokeLink({ linkId, secret: () => secret }, COMPENSATION_REASON);
    Logger.warn(`Liaison GestStock ${linkId} révoquée aussitôt : elle n'a pas pu être enregistrée ici.`, { shopId });
  } catch (error) {
    Logger.error(
      `Liaison GestStock ${linkId} ACTIVE chez GestStock mais non enregistrée ici, et révocation automatique impossible ` +
        `(${errorKind(error)}) : la révoquer manuellement depuis GestStock (Paramètres → Boutique en ligne).`,
      { shopId }
    );
  } finally {
    geststockClient.invalidateLinkToken(linkId);
  }
}

// --- Consulter -----------------------------------------------------------------------------------------

/**
 * Liaison non révoquée de la boutique, relue chez GestStock si son état date de plus d'une minute. GestStock
 * indisponible : état local, signalé « non actualisé » (`stale`), sans erreur. Liaison révoquée chez GestStock :
 * révoquée ici aussi.
 */
export async function currentGeststockLink(shopId: string): Promise<{ link: ShopLinkView | null; refreshed: boolean; stale: boolean }> {
  const link = await linkRepository.findCurrentByShop(shopId);
  if (!link) return { link: null, refreshed: false, stale: false };
  const age = link.lastStateSyncAt ? Date.now() - link.lastStateSyncAt.getTime() : Number.POSITIVE_INFINITY;
  if (age < LINK_REFRESH_AFTER_MS) return { link: shopView(link), refreshed: false, stale: false };
  try {
    const remote = await geststockClient.getLink(credentials(shopId, link.linkId));
    const updated = await linkRepository.applyRemoteState(shopId, link.linkId, {
      status: remote.status,
      suspensionReason: remote.suspensionReason,
      revocationReason: remote.revocationReason,
      currency: remote.currency,
      scopes: remote.scopes,
      warehouses: remote.warehouses,
      revokedAt: remote.revokedAt,
      syncedAt: new Date(),
    });
    return { link: shopView(updated ?? (await linkRepository.findByLinkId(shopId, link.linkId))), refreshed: true, stale: false };
  } catch (error) {
    if (error instanceof GeststockError && error.kind === 'LINK_REVOKED') {
      const revoked = await linkRepository.revoke(shopId, link.linkId, null, new Date());
      geststockClient.invalidateLinkToken(link.linkId);
      return { link: shopView(revoked ?? (await linkRepository.findByLinkId(shopId, link.linkId))), refreshed: true, stale: false };
    }
    Logger.warn(`Liaison GestStock ${link.linkId} non actualisée (${errorKind(error)}) : état local rendu.`, { shopId });
    return { link: shopView(link), refreshed: false, stale: true };
  }
}

// --- Révoquer ------------------------------------------------------------------------------------------

/**
 * Révocation par la boutique : GestStock d'abord ; si elle y réussit, ou si la liaison y est déjà révoquée,
 * révocation locale (secrets effacés, boutique libérée) et jeton oublié. GestStock injoignable : aucune
 * modification locale et erreur réessayable (effacer le secret ici laisserait chez GestStock une liaison active
 * que plus personne côté boutique ne pourrait révoquer).
 */
export async function revokeGeststockLink(shopId: string, reason?: string): Promise<{ link: ShopLinkView | null; revoked: boolean }> {
  const link = await linkRepository.findCurrentByShop(shopId);
  if (!link) return { link: null, revoked: false };
  let remoteReason: string | null = 'SHOP_REQUEST';
  let revokedAt = new Date();
  try {
    const result = await geststockClient.revokeLink(credentials(shopId, link.linkId), reason);
    if (result.link) {
      remoteReason = result.link.revocationReason ?? remoteReason;
      revokedAt = result.link.revokedAt ?? revokedAt;
    }
  } catch (error) {
    // Jeton refusé parce que la liaison est déjà révoquée chez GestStock : même issue qu'une révocation.
    if (!(error instanceof GeststockError && error.kind === 'LINK_REVOKED')) {
      if (error instanceof GeststockError && error.kind === 'REJECTED' && error.details.status === 400) {
        // Corps refusé par GestStock : réessayer à l'identique ne servirait à rien. Code d'erreur seulement.
        Logger.error(
          `Révocation de la liaison GestStock ${link.linkId} refusée par GestStock (400${error.details.code ? `, ${error.details.code}` : ''}) : ` +
            'aucune modification locale.',
          { shopId }
        );
        throw new GeststockRouteError(502, 'GESTSTOCK_REVOCATION_REJECTED', 'GestStock a refusé la demande de révocation.');
      }
      if (error instanceof LinkSecretError) {
        Logger.error(
          `Liaison GestStock ${link.linkId} : secret illisible, révocation impossible d'ici ; la révoquer manuellement ` +
            'depuis GestStock (Paramètres → Boutique en ligne).',
          { shopId }
        );
      }
      throw fromGeststock(error, 'révocation');
    }
    remoteReason = null;
  }
  const revoked = await linkRepository.revoke(shopId, link.linkId, remoteReason, revokedAt);
  geststockClient.invalidateLinkToken(link.linkId);
  Logger.info(`Liaison GestStock ${link.linkId} révoquée par la boutique.`, { shopId });
  return { link: shopView(revoked ?? (await linkRepository.findByLinkId(shopId, link.linkId))), revoked: true };
}

// --- Outils --------------------------------------------------------------------------------------------

/** Identifiants de la liaison : secret déchiffré seulement si un nouveau jeton est nécessaire. */
function credentials(shopId: string, linkId: string): LinkCredentials {
  return {
    linkId,
    secret: async () => {
      const secret = await linkRepository.revealSecret(shopId, linkId);
      if (!secret) throw new LinkSecretError();
      return secret;
    },
  };
}

function requestedScopes(): string[] {
  const configured = process.env.GESTSTOCK_SCOPES?.trim();
  if (!configured) return CONTRACT_SCOPES;
  const scopes = configured.split(/\s+/);
  if (!scopes.every((scope) => CONTRACT_SCOPES.includes(scope))) {
    throw new IntegrationConfigError('GESTSTOCK_SCOPES contient une portée inconnue du contrat.');
  }
  return scopes;
}

function errorKind(error: unknown): string {
  if (error instanceof GeststockError) return error.kind;
  return (error as Error)?.name ?? 'erreur';
}

/** Erreur du client GestStock, de configuration ou de secret, traduite en code stable. */
function fromGeststock(error: unknown, context: string): GeststockRouteError {
  if (error instanceof GeststockRouteError) return error;
  if (error instanceof GeststockError) {
    switch (error.kind) {
      case 'INVALID_ISSUER':
        return new GeststockRouteError(400, 'INVALID_ISSUER', 'Réponse d’autorisation d’un émetteur inattendu : recommencez la liaison.');
      case 'INVALID_GRANT':
        return new GeststockRouteError(400, 'AUTHORIZATION_REJECTED', 'GestStock a refusé l’autorisation (expirée ou déjà utilisée) : recommencez la liaison.');
      case 'LINK_REVOKED':
        return new GeststockRouteError(409, 'LINK_REVOKED', 'La liaison a été révoquée par GestStock : recommencez la liaison.');
      case 'RATE_LIMITED':
        return new GeststockRouteError(429, 'GESTSTOCK_RATE_LIMITED', 'GestStock reçoit trop de demandes : réessayez plus tard.', error.details.retryAfterSeconds);
      case 'UNAVAILABLE':
      case 'TIMEOUT':
      case 'NETWORK':
        return new GeststockRouteError(503, 'GESTSTOCK_UNAVAILABLE', 'GestStock est momentanément indisponible : réessayez dans quelques instants.');
      default:
        Logger.error(`Appel GestStock (${context}) : ${error.kind}.`);
        return new GeststockRouteError(502, 'GESTSTOCK_ERROR', 'Erreur de communication avec GestStock.');
    }
  }
  if (error instanceof IntegrationConfigError) {
    // Le message nomme la variable, jamais sa valeur.
    Logger.error(`Intégration GestStock mal configurée (${context}) : ${error.message}`);
    return new GeststockRouteError(503, 'INTEGRATION_MISCONFIGURED', 'L’intégration GestStock est momentanément indisponible.');
  }
  if (error instanceof LinkSecretError) {
    return new GeststockRouteError(500, 'LINK_SECRET_UNREADABLE', 'Le secret de la liaison est illisible : contactez le support.');
  }
  throw error;
}
