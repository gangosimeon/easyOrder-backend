import * as res from '@/lib/api-response';
import { geststockRoute } from '@/lib/geststock-route';
import { getUnmatchedCategories } from '@/services/geststock-category.service';

/**
 * GET /api/integrations/geststock/unmatched — listes des catégories GestStock et locales disponibles pour
 * un rapprochement manuel (lot 3, J11.1). Ne nécessite pas de liaison active.
 */
export async function GET(req: Request) {
  return geststockRoute(req, { name: 'unmatched', maxHits: 60, windowMs: 60_000, requireEligibleShop: false }, async (shop) => {
    return res.ok(await getUnmatchedCategories(shop.id));
  });
}
