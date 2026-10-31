import * as res from '@/lib/api-response';
import { geststockRoute } from '@/lib/geststock-route';
import { startGeststockLink } from '@/services/geststock-link.service';

/**
 * POST /api/integrations/geststock/start — démarre la liaison de la boutique connectée (lot 2, J4 ; v14-D1 étape 1).
 * Réponse : `authorizationUrl` seulement (ni `state`, ni vérificateur). Boutique approuvée exigée.
 */
export async function POST(req: Request) {
  return geststockRoute(req, { name: 'start', maxHits: 5, windowMs: 10 * 60_000, requireEligibleShop: true }, async (shop) =>
    res.created(await startGeststockLink(shop))
  );
}
