import { NextResponse } from 'next/server';
import { connectDB }    from '@/lib/db';
import { getOGCacheStats } from '@/lib/shop-og';

// ── /api/health — Endpoint de monitoring (Docker HEALTHCHECK, UptimeRobot…) ──
// Public : pas d'auth requise

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // Jamais mis en cache

export async function GET() {
  const start = Date.now();

  // ── Vérification MongoDB ───────────────────────────────────────────────────
  let dbStatus: 'ok' | 'error' = 'error';
  let dbLatencyMs = 0;

  try {
    const t0 = Date.now();
    await connectDB();
    dbLatencyMs = Date.now() - t0;
    dbStatus    = 'ok';
  } catch {
    dbStatus = 'error';
  }

  // ── Stats cache OG ─────────────────────────────────────────────────────────
  const ogCache = getOGCacheStats();

  // ── Mémoire heap Node.js ──────────────────────────────────────────────────
  const mem    = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);

  // ── Réponse ────────────────────────────────────────────────────────────────
  const healthy   = dbStatus === 'ok';
  const totalMs   = Date.now() - start;

  const body = {
    status:    healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
    latencyMs: totalMs,
    checks: {
      database: {
        status:    dbStatus,
        latencyMs: dbLatencyMs,
      },
      ogCache: {
        status:    'ok',
        entries:   ogCache.size,
        slugs:     ogCache.keys,
      },
      memory: {
        status: heapMb < 400 ? 'ok' : 'warning',
        heapMb,
      },
    },
    version: process.env.npm_package_version ?? '1.0.0',
    env:     process.env.NODE_ENV ?? 'unknown',
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, no-cache',
    },
  });
}
