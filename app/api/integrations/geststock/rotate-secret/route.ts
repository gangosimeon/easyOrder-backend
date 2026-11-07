import * as res from '@/lib/api-response';
import { geststockRoute } from '@/lib/geststock-route';
import { cancelSecretRotation, initiateSecretRotation } from '@/services/geststock-link.service';

/**
 * POST /api/integrations/geststock/rotate-secret — initie la rotation du secret de liaison GestStock
 * (lot 3, J12.2, G14) : GestStock génère un nouveau secret stocké en attente côté JCMB.
 *
 * DELETE /api/integrations/geststock/rotate-secret — annule la rotation en cours (lot 3, J12.2) :
 * GestStock supprime le secret en attente ; aucune modification du secret actif.
 */

export async function POST(req: Request) {
  return geststockRoute(req, { name: 'rotate-secret', maxHits: 5, windowMs: 10 * 60_000, requireEligibleShop: false }, async (shop) => {
    return res.ok(await initiateSecretRotation(shop.id));
  });
}

export async function DELETE(req: Request) {
  return geststockRoute(req, { name: 'rotate-secret', maxHits: 10, windowMs: 10 * 60_000, requireEligibleShop: false }, async (shop) => {
    return res.ok(await cancelSecretRotation(shop.id));
  });
}
