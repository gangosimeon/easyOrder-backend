/* ─────────────────────────────────────────────────────────────
   tracking-guard.ts
   Lightweight, dependency-free visit protection:
     1. Bot detection  — user-agent pattern matching
     2. Rate limiting  — in-memory sliding window per IP
   ───────────────────────────────────────────────────────────── */

// ── 1. Bot detection ─────────────────────────────────────────
const BOT_PATTERN =
  /bot|crawl|spider|slurp|baidu|bingbot|googlebot|yandex|duckduck|wget|curl|python-requests|python\/|go-http-client|java\/|libwww|scrapy|headlesschrome|phantomjs|selenium|puppeteer|playwright|apache-httpclient/i;

export function isBot(userAgent: string): boolean {
  if (!userAgent || userAgent === 'unknown') return true;
  return BOT_PATTERN.test(userAgent);
}

// ── 2. In-memory sliding-window rate limiter ─────────────────
// Note: resets on cold start (acceptable for single-server / dev).
// For multi-instance production, replace with Redis.

const RATE_WINDOW_MS = 60_000;   // 1 minute window
const RATE_MAX_HITS  = 15;       // max requests per IP per window

const rateMap = new Map<string, number[]>();

export function isRateLimited(ip: string): boolean {
  return checkRateLimit(ip, RATE_MAX_HITS, RATE_WINDOW_MS);
}

export function getClientIp(req: Request): string {
  const ipRaw = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  return ipRaw.split(',')[0].trim();
}

/**
 * Limiteur générique à fenêtre glissante, en mémoire, clé arbitraire.
 * Note : se réinitialise au redémarrage/cold start (acceptable pour un
 * serveur unique ; pour du multi-instance en production, remplacer par Redis).
 */
export function checkRateLimit(key: string, maxHits: number, windowMs: number): boolean {
  const now        = Date.now();
  const cutoff     = now - windowMs;
  const timestamps = (rateMap.get(key) ?? []).filter(t => t > cutoff);

  if (timestamps.length >= maxHits) {
    rateMap.set(key, timestamps);   // keep pruned list, don't add
    return true;
  }

  timestamps.push(now);
  rateMap.set(key, timestamps);
  return false;
}
