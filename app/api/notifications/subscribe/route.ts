import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { saveSubscription } from '@/services/push-notification.service';
import { z } from 'zod';

const subscribeSchema = z.object({
  endpoint: z.string().url('Endpoint invalide'),
  keys: z.object({
    p256dh: z.string().min(1, 'p256dh requis'),
    auth:   z.string().min(1, 'auth requis'),
  }),
});

export async function POST(req: Request) {
  try {
    await connectDB();

    const authUser = requireAuthUser(req);

    const body = await req.json();
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données de subscription invalides', parsed.error.flatten().fieldErrors);
    }

    const { endpoint, keys } = parsed.data;
    await saveSubscription(authUser.userId, endpoint, keys);

    return res.ok({ message: 'Subscription enregistrée' });
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    console.error('[POST /api/notifications/subscribe]', err);
    return res.serverError();
  }
}
