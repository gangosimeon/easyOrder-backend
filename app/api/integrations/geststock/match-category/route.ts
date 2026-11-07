import { z } from 'zod';

import * as res from '@/lib/api-response';
import { failure, geststockRoute } from '@/lib/geststock-route';
import { matchCategory } from '@/services/geststock-category.service';

/**
 * POST /api/integrations/geststock/match-category — fusionne une catégorie locale dans une catégorie GestStock
 * (lot 3, J11.1) : les produits de la catégorie locale sont déplacés, puis la catégorie locale est supprimée.
 */

const matchCategorySchema = z.object({
  geststockCategoryId: z.string().min(1),
  localCategoryId: z.string().min(1),
}).strict();

export async function POST(req: Request) {
  return geststockRoute(req, { name: 'match-category', maxHits: 30, windowMs: 60_000, requireEligibleShop: false }, async (shop) => {
    let body: unknown;
    try { body = await req.json(); } catch { return failure(400, 'INVALID_REQUEST', 'Corps JSON invalide'); }
    const parsed = matchCategorySchema.safeParse(body);
    if (!parsed.success) return failure(400, 'INVALID_REQUEST', 'Données invalides');

    try {
      return res.ok(await matchCategory(shop.id, parsed.data.geststockCategoryId, parsed.data.localCategoryId));
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 404) return failure(404, 'CATEGORY_NOT_FOUND', e.message ?? 'Catégorie introuvable');
      throw err;
    }
  });
}
