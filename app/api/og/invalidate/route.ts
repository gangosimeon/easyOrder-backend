import { NextRequest, NextResponse } from 'next/server';
import { invalidateShopOGCache, clearAllOGCache, getOGCacheStats } from '@/lib/shop-og';

// ── Secret partagé pour protéger cet endpoint ─────────────────────────────────
//   Définir CACHE_INVALIDATION_SECRET dans .env.local
const INVALIDATION_SECRET = process.env.CACHE_INVALIDATION_SECRET ?? '';

function isAuthorized(request: NextRequest): boolean {
  if (!INVALIDATION_SECRET) return false; // désactivé si secret non configuré
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${INVALIDATION_SECRET}`;
}

// ── POST /api/og/invalidate — invalide un ou tous les slugs ──────────────────
//   Body JSON :  { "slug": "merveille-shop" }   → invalide un slug
//                { "all": true }                 → vide tout le cache
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { success: false, message: 'Non autorisé' },
      { status: 401 }
    );
  }

  let body: { slug?: string; all?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Corps JSON invalide' },
      { status: 400 }
    );
  }

  if (body.all === true) {
    clearAllOGCache();
    return NextResponse.json({ success: true, message: 'Cache OG entièrement vidé' });
  }

  if (typeof body.slug === 'string' && body.slug.trim()) {
    const removed = invalidateShopOGCache(body.slug.trim());
    return NextResponse.json({
      success: true,
      message: removed
        ? `Cache invalidé pour "${body.slug}"`
        : `Aucune entrée en cache pour "${body.slug}"`,
    });
  }

  return NextResponse.json(
    { success: false, message: 'Paramètre "slug" ou "all" requis' },
    { status: 400 }
  );
}

// ── GET /api/og/invalidate — statistiques du cache (monitoring) ───────────────
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { success: false, message: 'Non autorisé' },
      { status: 401 }
    );
  }

  const stats = getOGCacheStats();
  return NextResponse.json({ success: true, cache: stats });
}
