import webpush from 'web-push';
import PushSubscription from '@/models/push-subscription.model';

function getVapidDetails() {
  const publicKey  = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject    = process.env.VAPID_SUBJECT || 'mailto:jecreemaboutique@gmail.com';

  if (!publicKey || !privateKey) {
    throw new Error('VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY sont requis dans .env.local');
  }

  return { publicKey, privateKey, subject };
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
}

export async function saveSubscription(
  userId: string,
  endpoint: string,
  keys: { p256dh: string; auth: string }
): Promise<void> {
  // Upsert : si le endpoint existe déjà pour cet utilisateur, on le met à jour
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { userId, endpoint, keys },
    { upsert: true, new: true }
  );
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await PushSubscription.deleteOne({ endpoint });
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<void> {
  const { publicKey, privateKey, subject } = getVapidDetails();

  webpush.setVapidDetails(subject, publicKey, privateKey);

  const subscriptions = await PushSubscription.find({ userId }).lean();

  if (subscriptions.length === 0) return;

  const expiredEndpoints: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth:   sub.keys.auth,
        },
      };

      // Payload au format Angular ngsw :
      // - "notification" est le format attendu par ngsw-worker.js
      // - "data.onActionClick" permet d'ouvrir la bonne URL au clic
      const targetUrl = payload.url || '/orders';
      const notificationPayload = JSON.stringify({
        notification: {
          title:   payload.title,
          body:    payload.body,
          icon:    payload.icon  || '/assets/icons/web-app-manifest-192x192.png',
          badge:   payload.badge || '/assets/icons/web-app-manifest-96x96.png',
          vibrate: [200, 100, 200],
          tag:     'new-order',
          renotify: true,
          data: {
            url: targetUrl,
            onActionClick: {
              default: {
                operation: 'navigateLastFocusedOrOpen',
                url: targetUrl,
              },
            },
          },
        },
      });

      try {
        await webpush.sendNotification(pushSubscription, notificationPayload);
      } catch (err: unknown) {
        const e = err as { statusCode?: number };
        // 404 ou 410 : subscription expirée, à supprimer
        if (e.statusCode === 404 || e.statusCode === 410) {
          expiredEndpoints.push(sub.endpoint);
          console.warn(`[PushNotification] Subscription expirée supprimée: ${sub.endpoint.slice(0, 60)}...`);
        } else {
          console.error('[PushNotification] Erreur envoi push:', err);
        }
      }
    })
  );

  // Nettoyage des subscriptions expirées
  if (expiredEndpoints.length > 0) {
    await PushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } });
  }
}
