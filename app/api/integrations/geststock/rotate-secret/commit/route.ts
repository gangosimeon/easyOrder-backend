import * as res from '@/lib/api-response';
import { geststockRoute } from '@/lib/geststock-route';
import { commitSecretRotation } from '@/services/geststock-link.service';

/**
 * POST /api/integrations/geststock/rotate-secret/commit — valide la rotation du secret (lot 3, J12.2, G14) :
 * GestStock invalide l'ancien secret ; le secret en attente devient l'actif côté JCMB et le jeton est
 * invalidé pour forcer un renouvellement avec le nouveau secret.
 */
export async function POST(req: Request) {
  return geststockRoute(req, { name: 'rotate-secret', maxHits: 5, windowMs: 10 * 60_000, requireEligibleShop: false }, async (shop) => {
    return res.ok(await commitSecretRotation(shop.id));
  });
}
