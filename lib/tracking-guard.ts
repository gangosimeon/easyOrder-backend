/* ─────────────────────────────────────────────────────────────
   tracking-guard.ts
   Protection anti-abus sans dépendance externe :
     1. Détection de bots  — motifs de user-agent
     2. Rate limiting      — compteurs partagés en base (MongoDB, TTL)
   ───────────────────────────────────────────────────────────── */

import { connectDB } from '@/lib/db';
import RateLimit from '@/models/rate-limit.model';

// ── 1. Bot detection ─────────────────────────────────────────
const BOT_PATTERN =
  /bot|crawl|spider|slurp|baidu|bingbot|googlebot|yandex|duckduck|wget|curl|python-requests|python\/|go-http-client|java\/|libwww|scrapy|headlesschrome|phantomjs|selenium|puppeteer|playwright|apache-httpclient/i;

export function isBot(userAgent: string): boolean {
  if (!userAgent || userAgent === 'unknown') return true;
  return BOT_PATTERN.test(userAgent);
}

// ── 2. Rate limiting partagé ─────────────────────────────────
// Un compteur en mémoire ne protège rien dès qu'il y a plusieurs instances
// (serverless Vercel, redémarrages de conteneur) : chaque instance repartirait
// de zéro. Les compteurs vivent donc en base, en fenêtres fixes.

/**
 * IP du client. `x-real-ip` est posé par le proxy de confiance (Vercel, nginx)
 * et écrase toute valeur envoyée par le client ; le premier élément de
 * `x-forwarded-for`, lui, peut être forgé derrière un proxy qui ne fait
 * qu'ajouter l'IP en fin de liste.
 */
export function getClientIp(req: Request): string {
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0].trim() : 'unknown';
}

/**
 * Renvoie `true` si la clé a dépassé `maxHits` requêtes dans la fenêtre
 * courante de `windowMs`. Chaque appel compte comme une requête.
 * En cas d'indisponibilité de la base, on laisse passer : la route échouera
 * de toute façon plus loin sur la même base.
 */
export async function checkRateLimit(key: string, maxHits: number, windowMs: number): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  try {
    await connectDB();
    const doc = await RateLimit.findOneAndUpdate(
      { _id: `${key}:${windowStart}` },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs) } },
      { upsert: true, new: true, lean: true }
    );
    return (doc?.count ?? 0) > maxHits;
  } catch (err) {
    console.error('[rate-limit] indisponible :', err);
    return false;
  }
}

const VISIT_WINDOW_MS = 60_000;   // 1 minute
const VISIT_MAX_HITS  = 15;       // requêtes max par IP et par fenêtre

export function isRateLimited(ip: string): Promise<boolean> {
  return checkRateLimit(`visit:ip:${ip}`, VISIT_MAX_HITS, VISIT_WINDOW_MS);
}
