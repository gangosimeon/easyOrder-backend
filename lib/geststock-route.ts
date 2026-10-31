import { NextResponse } from 'next/server';

import { getAuthUser } from '@/lib/auth';
import { connectDB } from '@/lib/db';
import { isIntegrationEnabled } from '@/lib/integration-crypto';
import { Logger } from '@/lib/logger';
import { hitRateLimit } from '@/lib/tracking-guard';
import User from '@/models/user.model';
import { GeststockRouteError } from '@/services/geststock-link.service';

/**
 * Contrôles communs des routes de la liaison GestStock (intégration GestStock, lot 2, J4), dans l'ordre :
 * 1. interrupteur `GESTSTOCK_INTEGRATION_ENABLED` désactivé → 404 `INTEGRATION_DISABLED` (comme une route inconnue,
 *    plan §27.6), sans aucun appel ;
 * 2. utilisateur authentifié (`getAuthUser` : jeton Bearer, utilisateur rechargé, boutique bannie refusée) → sinon
 *    401 `UNAUTHENTICATED` ;
 * 3. rôle `admin` refusé (v14-D13) → 403 `ADMIN_FORBIDDEN` ; la boutique est toujours l'utilisateur lui-même ;
 * 4. démarrer et terminer : boutique approuvée (`isActive`) → sinon 403 `SHOP_NOT_ELIGIBLE` ;
 * 5. limiteur par utilisateur, **fermé en cas de panne** : 429 `RATE_LIMITED` (Retry-After), 503
 *    `RATE_LIMIT_UNAVAILABLE`.
 * Erreurs : `{ success: false, message, code }`, codes stables pour l'écran JA1 ; réponses jamais mises en cache.
 */

export interface GeststockRouteOptions {
  /** Nom de la route (clé du limiteur, journaux). */
  name: 'start' | 'complete' | 'link' | 'revoke';
  maxHits: number;
  windowMs: number;
  /** Démarrer et terminer : boutique approuvée exigée. */
  requireEligibleShop: boolean;
}

export interface GeststockShop {
  id: string;
  name: string;
}

export async function geststockRoute(
  req: Request,
  options: GeststockRouteOptions,
  handler: (shop: GeststockShop) => Promise<Response>
): Promise<Response> {
  try {
    if (!isIntegrationEnabled()) {
      return failure(404, 'INTEGRATION_DISABLED', 'Ressource introuvable');
    }
    await connectDB();
    const auth = await getAuthUser(req);
    if (!auth) return failure(401, 'UNAUTHENTICATED', 'Non authentifié');
    const user = await User.findById(auth.userId).select('role isActive banned name').lean<{
      role: string;
      isActive?: boolean;
      banned?: boolean;
      name: string;
    }>();
    if (!user) return failure(401, 'UNAUTHENTICATED', 'Non authentifié');
    if (auth.role === 'admin' || user.role === 'admin') {
      return failure(403, 'ADMIN_FORBIDDEN', 'La liaison GestStock est réservée aux boutiques.');
    }
    if (options.requireEligibleShop && (user.isActive === false || user.banned === true)) {
      return failure(403, 'SHOP_NOT_ELIGIBLE', 'Votre boutique doit être approuvée pour être liée à GestStock.');
    }

    let limit;
    try {
      limit = await hitRateLimit(`geststock:${options.name}:user:${auth.userId}`, options.maxHits, options.windowMs);
    } catch {
      Logger.error(`Limiteur indisponible : route GestStock ${options.name} refusée.`, { userId: auth.userId });
      return failure(503, 'RATE_LIMIT_UNAVAILABLE', 'Service momentanément indisponible, réessayez plus tard.');
    }
    if (limit.limited) {
      return failure(429, 'RATE_LIMITED', 'Trop de demandes, réessayez plus tard.', limit.retryAfterSeconds);
    }

    return noStore(await handler({ id: auth.userId, name: user.name }));
  } catch (error) {
    if (error instanceof GeststockRouteError) {
      return failure(error.status, error.code, error.message, error.retryAfterSeconds);
    }
    Logger.error(`Route GestStock ${options.name} : erreur inattendue (${(error as Error)?.name ?? 'erreur'}).`);
    return failure(500, 'INTERNAL_ERROR', 'Erreur serveur interne');
  }
}

/** Corps JSON lu sans lever d'erreur ; corps vide accepté (révocation sans motif). */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function failure(status: number, code: string, message: string, retryAfterSeconds?: number): Response {
  const response = NextResponse.json({ success: false, message, code }, { status });
  if (retryAfterSeconds !== undefined) response.headers.set('Retry-After', String(retryAfterSeconds));
  return noStore(response);
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
