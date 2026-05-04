import { Types } from 'mongoose';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import ShopVisit from '@/models/shop-visit.model';
import { isBot, isRateLimited } from '@/lib/tracking-guard';

const visitSchema = z.object({
  shopId:    z.string().refine((v) => Types.ObjectId.isValid(v), { message: 'shopId invalide' }),
  visitorId: z.string().min(1, 'visitorId requis'),
  source:    z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const ipRaw     = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
    const ipAddress = ipRaw.split(',')[0].trim();
    const userAgent = req.headers.get('user-agent') ?? 'unknown';

    // ── Guard 1: reject bots ──────────────────────────────────
    if (isBot(userAgent)) {
      return res.ok({ recorded: false });
    }

    // ── Guard 2: rate limit per IP (15 req / min) ─────────────
    if (isRateLimited(ipAddress)) {
      return res.ok({ recorded: false });
    }

    // ── Validate body ─────────────────────────────────────────
    const body = await req.json();
    const parsed = visitSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const { shopId, visitorId, source } = parsed.data;

    await connectDB();

    // ── Guard 3: 30-min deduplication (already in place) ─────
    const since    = new Date(Date.now() - 30 * 60 * 1000);
    const existing = await ShopVisit.exists({
      shopId:    new Types.ObjectId(shopId),
      visitorId,
      visitedAt: { $gte: since },
    });

    if (!existing) {
      await ShopVisit.create({
        shopId:    new Types.ObjectId(shopId),
        visitorId,
        ipAddress,
        userAgent,
        source,
      });
    }

    return res.ok({ recorded: !existing });
  } catch {
    return res.serverError();
  }
}
