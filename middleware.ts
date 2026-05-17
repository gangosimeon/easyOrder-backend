import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ── Public API routes (pas besoin de JWT) ────────────────────────────────────
const PUBLIC_ROUTES = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/public',
  '/api/orders',
  '/api/swagger',
  '/api/shops/visit',
  '/api/og',          // OG image route — toujours publique
];

// ── User-agents des crawlers / bots sociaux ──────────────────────────────────
const BOT_PATTERNS = [
  'facebookexternalhit',
  'facebookcatalog',
  'twitterbot',
  'whatsapp',
  'telegrambot',
  'linkedinbot',
  'slackbot',
  'discordbot',
  'pinterestbot',
  'googlebot',
  'bingbot',
  'duckduckbot',
  'baiduspider',
  'yandexbot',
  'sogou',
  'ia_archiver',
  'ahrefsbot',
  'semrushbot',
  'rogerbot',
  'vkshare',
  'w3c_validator',
  'applebot',
  'iframely',
  'preview',
  'crawler',
  'spider',
];

function isBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return BOT_PATTERNS.some(pattern => ua.includes(pattern));
}

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://www.jecreemaboutique.com';

// ── Middleware principal ──────────────────────────────────────────────────────
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Gestion des routes /shop/:slug (preview social) ─────────────────────
  if (pathname.startsWith('/shop/')) {
    const ua = request.headers.get('user-agent') ?? '';

    if (isBot(ua)) {
      // Crawleur → Next.js sert la page SSR avec les meta OG
      return NextResponse.next();
    }

    // Vrai utilisateur → redirection vers Angular
    const slug = pathname.split('/')[2] ?? '';
    const destination = slug
      ? `${FRONTEND_URL}/shop/${slug}`
      : FRONTEND_URL;

    return NextResponse.redirect(destination, { status: 302 });
  }

  // ── Gestion des routes /api/* ────────────────────────────────────────────
  if (request.method === 'OPTIONS') return NextResponse.next();

  const isPublic = PUBLIC_ROUTES.some(route => pathname.startsWith(route));
  if (isPublic) return NextResponse.next();

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json(
      { success: false, message: 'Non authentifié' },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/:path*',
    '/shop/:path*',
  ],
};
