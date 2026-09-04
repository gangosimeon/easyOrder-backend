/**
 * Cloudflare Worker — JeCréeMaBoutique
 *
 * Rôle : détecter les bots sur /shop/:slug et les rediriger vers Next.js SSR
 *        (easyorder-backend-wnku.onrender.com) pour les meta OG dynamiques.
 *        Tous les autres visiteurs reçoivent l'Angular SPA normalement.
 *
 * Déploiement :
 *   1. Aller sur dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Coller ce code
 *   3. Dans "Triggers" → ajouter la route : jecreemaboutique.com/shop/*
 */

const NEXTJS_ORIGIN = 'https://easyorder-backend-wnku.onrender.com';

// ── Patterns de bots (en minuscules) ────────────────────────────────────────
const BOT_PATTERNS = [
  // Réseaux sociaux
  'whatsapp', 'facebookexternalhit', 'facebookcatalog', 'facebot',
  'twitterbot', 'telegrambot', 'linkedinbot', 'linkedinupdater',
  'discordbot', 'slackbot', 'slack-imgproxy',
  'bytespider', 'tiktokbot', 'pinterestbot',
  'snapchat', 'viber', 'vkshare',
  // Moteurs de recherche
  'googlebot', 'google-inspectiontool',
  'bingbot', 'msnbot', 'duckduckbot', 'applebot', 'yandexbot', 'baiduspider',
  // Outils d'aperçu
  'iframely', 'w3c_validator',
  // Génériques (en dernier)
  'crawler', 'spider',
];

function isBot(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  return BOT_PATTERNS.some(p => ua.includes(p));
}

// ── Extrait le slug depuis /shop/:slug ────────────────────────────────────
function extractSlug(pathname) {
  const match = pathname.match(/^\/shop\/([^/]+)/);
  return match ? match[1] : null;
}

// ── Handler principal ─────────────────────────────────────────────────────
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url    = new URL(request.url);
  const ua     = request.headers.get('user-agent') || '';
  const isShop = url.pathname.startsWith('/shop/');

  // ── Route bots /shop/:slug → Next.js SSR ─────────────────────────────
  if (isShop && isBot(ua)) {
    const slug    = extractSlug(url.pathname);
    const nextUrl = `${NEXTJS_ORIGIN}/shop/${slug}${url.search}`;

    const headers = new Headers({
      'user-agent':        ua,
      'accept':            request.headers.get('accept') || 'text/html',
      'x-forwarded-for':   request.headers.get('cf-connecting-ip') || '',
      'x-forwarded-proto': 'https',
      'x-original-uri':    url.pathname + url.search,
      'host':              new URL(NEXTJS_ORIGIN).hostname,
    });

    const response = await fetch(nextUrl, { headers, method: 'GET' });

    // Recopie la réponse en ajoutant les headers de debug
    const newHeaders = new Headers(response.headers);
    newHeaders.set('x-bot-detected', 'true');
    newHeaders.set('x-bot-routed-to', 'nextjs-ssr');

    return new Response(response.body, {
      status:  response.status,
      headers: newHeaders,
    });
  }

  // ── Tout le reste → Angular SPA (Render Static Site) ─────────────────
  return fetch(request);
}
