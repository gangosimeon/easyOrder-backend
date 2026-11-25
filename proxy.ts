
/**
 * middleware.ts — JeCréeMaBoutique
 *
 * Responsabilités :
 *  1. Routes /shop/:slug
 *     • Bot social/search → Next.js SSR (retourne HTML + meta OG aux crawlers)
 *     • Utilisateur réel  → Redirect 302 vers Angular SPA
 *
 *  2. Routes /api/*
 *     • Routes publiques  → Passthrough
 *     • Routes privées    → Vérification présence du token Bearer (JWT vérifié côté handler)
 *
 * Sécurité :
 *  • Host header injection protection
 *  • Security headers ajoutés sur toutes les réponses
 *  • Query string préservée dans les redirections
 *  • User-Agent vide traité comme utilisateur humain
 *
 * Debug :
 *  Quand un bot est détecté, des headers X-Bot-* sont ajoutés pour faciliter
 *  le monitoring et le débogage via curl / Postman.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { detectBot } from '@/lib/bot-detector';

// ── Configuration ──────────────────────────────────────────────────────────────
const FRONTEND_URL =
  (process.env.FRONTEND_URL ?? 'https://www.jecreemaboutique.com').replace(/\/$/, '');

const ALLOWED_ORIGINS = [
  'https://www.jecreemaboutique.com',
  'https://localhost',
  'http://localhost:4200',
  'http://localhost:4300',
];

// ── Routes publiques (pas de JWT requis) ──────────────────────────────────────
const PUBLIC_API_PREFIXES = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/forgot-password',   // Réinitialisation mot de passe
  '/api/auth/verify-otp',        // Vérification OTP
  '/api/auth/reset-password',    // Nouveau mot de passe
  '/api/auth/refresh',           // Authentifié par refresh token dans le body, pas par Bearer
  '/api/public',                 // Données boutique publiques
  '/api/orders',                 // Commandes (créées sans compte)
  '/api/swagger',
  '/api/shops/visit',            // Tracking des visites
  '/api/og',                     // OG image + invalidation cache
  '/api/health',                 // Monitoring (UptimeRobot, healthcheck)
];

// ── Headers de sécurité ajoutés sur toutes les réponses ──────────────────────
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// ── Applique les security headers sur une réponse NextResponse ────────────────
function withSecurityHeaders(res: NextResponse): NextResponse {
  Object.entries(SECURITY_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

// ── Application CORS ──────────────────────────────────────────────────────
function withCors(
  response: NextResponse,
  origin: string | null
): NextResponse {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    );
    response.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization'
    );
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Expose-Headers', 'Retry-After');
    response.headers.set('Access-Control-Max-Age', '86400');
  }

  return withSecurityHeaders(response);
}

// ── Extrait proprement le slug depuis /shop/:slug[/...] ───────────────────────
function extractSlug(pathname: string): string {
  const parts = pathname.split('/');
  // parts = ['', 'shop', 'merveille-shop', ...]
  return parts[2] ?? '';
}

// ── Reconstruit l'URL de destination en préservant la query string ────────────
function buildAngularUrl(slug: string, search: string): string {
  const path = slug ? `/shop/${encodeURIComponent(slug)}` : '';
  return `${FRONTEND_URL}${path}${search}`;
}

// ── Middleware principal ───────────────────────────────────────────────────────
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const origin = request.headers.get('origin');

  // ─── 1. Routes /shop/:slug ────────────────────────────────────────────────
  if (pathname.startsWith('/shop/')) {
    const ua = request.headers.get('user-agent') ?? '';
    const result = detectBot(ua);

    // ── Bot détecté → Next.js sert la page SSR avec les meta OG ─────────────
    if (result.isBot) {
      const response = NextResponse.next();

      // Headers de debug (visibles dans curl / network tab)
      response.headers.set('X-Bot-Detected', 'true');
      response.headers.set('X-Bot-Name', result.name);
      response.headers.set('X-Bot-Category', result.category);
      response.headers.set('X-Bot-Pattern', result.pattern);

      // Cache permissif pour les bots : pas de cookies, réponse statique
      response.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=3600');

      return withSecurityHeaders(response);
    }

    // ── Utilisateur réel → Angular SPA ──────────────────────────────────────
    const slug = extractSlug(pathname);
    const destination = buildAngularUrl(slug, search);

    const redirect = NextResponse.redirect(destination, { status: 302 });
    redirect.headers.set('X-Bot-Detected', 'false');

    return withSecurityHeaders(redirect);
  }

  // ─── 2. Routes /api/* ────────────────────────────────────────────────────

  // ── Gestion des requêtes CORS préliminaires ──────────────────────────────
  if (pathname.startsWith('/api/') && request.method === 'OPTIONS') {
    return withCors(
      new NextResponse(null, { status: 204 }),
      origin
    );
  }

  const isPublic = PUBLIC_API_PREFIXES.some(prefix => pathname.startsWith(prefix));
  if (isPublic) {
    return withCors(NextResponse.next(), origin);
  }

  // ── Vérification présence du token Bearer ────────────────────────────────
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return withCors(
      NextResponse.json(
        { success: false, message: 'Non authentifié', code: 'MISSING_TOKEN' },
        { status: 401 }
      ),
      origin
    );
  }

  return withCors(NextResponse.next(), origin);
}

// ── Matcher : uniquement les routes concernées ────────────────────────────────
// Exclut les assets statiques (_next/static, _next/image, favicon.ico…)
export const config = {
  matcher: [
    '/api/:path*',
    '/shop/:path*',
  ],
};
