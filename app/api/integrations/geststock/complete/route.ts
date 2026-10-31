import * as res from '@/lib/api-response';
import { failure, geststockRoute, readJson } from '@/lib/geststock-route';
import { completeGeststockLinkSchema } from '@/validators/geststock.validator';
import { completeGeststockLink } from '@/services/geststock-link.service';

/**
 * POST /api/integrations/geststock/complete — termine la liaison au retour de l'écran d'autorisation (lot 2, J4 ;
 * v14-D1 étape 4). Corps `{ code, state, iss }` : la demande est consommée avant tout appel à GestStock. Réponse : la
 * liaison, sans aucun secret. Boutique approuvée exigée.
 */
export async function POST(req: Request) {
  return geststockRoute(req, { name: 'complete', maxHits: 10, windowMs: 10 * 60_000, requireEligibleShop: true }, async (shop) => {
    const parsed = completeGeststockLinkSchema.safeParse(await readJson(req));
    // Aucun détail : les valeurs refusées (code, state) ne sont jamais renvoyées.
    if (!parsed.success) return failure(400, 'INVALID_REQUEST', 'Données invalides');
    return res.created(await completeGeststockLink(shop.id, parsed.data));
  });
}
