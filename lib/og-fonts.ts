/**
 * og-fonts.ts
 *
 * Charge Inter via la Google Fonts CSS API v2.
 * Compatible Edge Runtime (pas d'AbortSignal.timeout, pas d'APIs Node.js).
 *
 * Stratégie :
 *   - Promise.race pour le timeout (universel : Edge + Node.js + Cloudflare)
 *   - Module-level singleton → chargé une fois par worker/instance
 *   - Fallback silencieux → Satori utilise les polices système si échec
 */

type Weight = 400 | 700 | 900;

interface SatoriFont {
  name:   string;
  data:   ArrayBuffer;
  weight: Weight;
  style:  'normal';
}

// ── Timeout universel (compatible tous runtimes) ───────────────────────────────
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Font fetch timeout (${ms}ms)`)), ms)
    ),
  ]);
}

// ── Fetch une police depuis Google Fonts CSS API v1 ───────────────────────────
// Satori (next/og) ne supporte PAS le format woff2 — il exige TTF/OTF.
// L'API v1 avec un vieux User-Agent retourne du TTF (format truetype).
async function fetchGoogleFont(family: string, weight: Weight): Promise<ArrayBuffer | null> {
  try {
    // CSS API v1 : retourne TTF avec un ancien User-Agent
    const cssUrl =
      `https://fonts.googleapis.com/css?family=${encodeURIComponent(family)}:${weight}`;

    const css = await withTimeout(
      fetch(cssUrl, {
        // Vieux UA → Google Fonts retourne TTF au lieu de woff2
        headers: {
          'User-Agent': 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.0)',
        },
      }).then(r => {
        if (!r.ok) throw new Error(`Google Fonts CSS ${r.status}`);
        return r.text();
      }),
      6_000
    );

    // Extrait l'URL TTF (truetype) de la règle @font-face
    const match = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?truetype['"]?\)/);
    if (!match?.[1]) return null;

    return withTimeout(
      fetch(match[1]).then(r => r.arrayBuffer()),
      6_000
    );
  } catch {
    return null;
  }
}

// ── Singleton module-level : 3 graisses chargées en parallèle ─────────────────
export const ogFonts: Promise<SatoriFont[] | undefined> = (async () => {
  const [regular, bold, black] = await Promise.all([
    fetchGoogleFont('Inter', 400),
    fetchGoogleFont('Inter', 700),
    fetchGoogleFont('Inter', 900),
  ]);

  const fonts: SatoriFont[] = [];
  if (regular) fonts.push({ name: 'Inter', data: regular, weight: 400, style: 'normal' });
  if (bold)    fonts.push({ name: 'Inter', data: bold,    weight: 700, style: 'normal' });
  if (black)   fonts.push({ name: 'Inter', data: black,   weight: 900, style: 'normal' });

  return fonts.length > 0 ? fonts : undefined;
})();
