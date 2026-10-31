import * as res from '@/lib/api-response';
import { failure, geststockRoute, readJson } from '@/lib/geststock-route';
import { revokeGeststockLinkSchema } from '@/validators/geststock.validator';
import { revokeGeststockLink } from '@/services/geststock-link.service';

/**
 * POST /api/integrations/geststock/revoke — révoque la liaison de la boutique connectée (lot 2, J4) : GestStock
 * d'abord, puis localement. Corps facultatif `{ reason }` (500 caractères au plus, transmis à GestStock). Sans
 * liaison : `{ link: null, revoked: false }`.
 */
export async function POST(req: Request) {
  return geststockRoute(req, { name: 'revoke', maxHits: 5, windowMs: 10 * 60_000, requireEligibleShop: false }, async (shop) => {
    const parsed = revokeGeststockLinkSchema.safeParse(await readJson(req));
    if (!parsed.success) return failure(400, 'INVALID_REQUEST', 'Données invalides');
    return res.ok(await revokeGeststockLink(shop.id, parsed.data.reason));
  });
}
