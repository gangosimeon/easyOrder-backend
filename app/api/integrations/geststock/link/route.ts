import * as res from '@/lib/api-response';
import { geststockRoute } from '@/lib/geststock-route';
import { currentGeststockLink } from '@/services/geststock-link.service';

/**
 * GET /api/integrations/geststock/link — liaison non révoquée de la boutique connectée, ou `null` (lot 2, J4).
 * Relue chez GestStock si son état date de plus d'une minute ; `stale` : GestStock indisponible, état local rendu.
 */
export async function GET(req: Request) {
  return geststockRoute(req, { name: 'link', maxHits: 30, windowMs: 60_000, requireEligibleShop: false }, async (shop) =>
    res.ok(await currentGeststockLink(shop.id))
  );
}
