import * as res from '@/lib/api-response';

export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;

  if (!publicKey) {
    console.error('[GET /api/notifications/vapid-public-key] VAPID_PUBLIC_KEY manquant');
    return res.serverError('Configuration push notification manquante');
  }

  return res.ok({ publicKey });
}
