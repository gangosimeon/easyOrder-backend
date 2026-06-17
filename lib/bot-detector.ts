/**
 * bot-detector.ts
 *
 * Détecte et classifie les bots/crawlers à partir du User-Agent.
 * Compatible Edge Runtime (pas d'APIs Node.js).
 *
 * Utilisation :
 *   const result = detectBot(request.headers.get('user-agent') ?? '');
 *   if (result.isBot && result.category === 'social') { ... }
 */

// ── Types exportés ─────────────────────────────────────────────────────────────

/** Catégorie du bot détecté */
export type BotCategory = 'social' | 'search' | 'preview' | 'archiver';

/** Bot détecté */
export interface BotMatch {
  isBot:    true;
  name:     string;       // Nom lisible : 'Facebook', 'WhatsApp', 'Telegram'...
  pattern:  string;       // Pattern UA ayant matché : 'facebookexternalhit'
  category: BotCategory;
}

/** Pas un bot */
export interface HumanVisit {
  isBot:    false;
  name:     null;
  pattern:  null;
  category: null;
}

export type DetectionResult = BotMatch | HumanVisit;

// ── Registre des bots ─────────────────────────────────────────────────────────
// Ordre important : du plus spécifique au plus général dans chaque catégorie.
// Chaque entrée peut avoir plusieurs patterns (tous en minuscules).

interface BotEntry {
  name:     string;
  patterns: string[];
  category: BotCategory;
}

const BOT_REGISTRY: BotEntry[] = [
  // ── Réseaux sociaux ── (priorité critique pour les previews) ─────────────────

  {
    name:     'WhatsApp',
    // whatsapp        : UA device WhatsApp (status & messages mobiles)
    // whatsapp-media  : crawler media WhatsApp
    patterns: ['whatsapp'],
    category: 'social',
  },
  {
    name:     'Facebook',
    // facebookexternalhit : crawler Open Graph standard (Facebook App + Lite)
    // facebookcatalog     : crawler catalogue produits
    // facebot             : crawler interne Facebook Messages
    // facebookbot         : variante documentée pour certains outils Meta
    patterns: ['facebookexternalhit', 'facebookcatalog', 'facebot', 'facebookbot'],
    category: 'social',
  },
  {
    name:     'Telegram',
    patterns: ['telegrambot'],
    category: 'social',
  },
  {
    name:     'Twitter / X',
    // twitterbot : crawler standard
    // card-validator : outil de validation des Twitter Cards
    patterns: ['twitterbot', 'card-validator'],
    category: 'social',
  },
  {
    name:     'LinkedIn',
    // linkedinbot : crawler principal
    // linkedinupdater : Bot de mise à jour de prévisualisation
    patterns: ['linkedinbot', 'linkedinupdater'],
    category: 'social',
  },
  {
    name:     'Discord',
    patterns: ['discordbot'],
    category: 'social',
  },
  {
    name:     'Slack',
    // slackbot : crawler principal
    // slack-imgproxy : proxy d'images Slack
    patterns: ['slackbot', 'slack-imgproxy'],
    category: 'social',
  },
  {
    name:     'TikTok',
    // bytespider : crawler principal ByteDance (TikTok)
    // tiktokbot  : déclaration explicite rare mais documentée
    patterns: ['bytespider', 'tiktokbot'],
    category: 'social',
  },
  {
    name:     'Pinterest',
    patterns: ['pinterestbot', 'pinterest'],
    category: 'social',
  },
  {
    name:     'Snapchat',
    patterns: ['snapchat'],
    category: 'social',
  },
  {
    name:     'VK',
    patterns: ['vkshare', 'vkrobot'],
    category: 'social',
  },
  {
    name:     'Viber',
    patterns: ['viber'],
    category: 'social',
  },
  {
    name:     'Line',
    patterns: ['line-poker'],
    category: 'social',
  },

  // ── Moteurs de recherche ─────────────────────────────────────────────────────

  {
    name:     'Google',
    patterns: ['googlebot', 'google-inspectiontool', 'apis-google'],
    category: 'search',
  },
  {
    name:     'Bing',
    patterns: ['bingbot', 'msnbot'],
    category: 'search',
  },
  {
    name:     'DuckDuckGo',
    patterns: ['duckduckbot'],
    category: 'search',
  },
  {
    name:     'Baidu',
    patterns: ['baiduspider'],
    category: 'search',
  },
  {
    name:     'Yandex',
    patterns: ['yandexbot'],
    category: 'search',
  },
  {
    name:     'Apple',
    patterns: ['applebot'],
    category: 'search',
  },
  {
    name:     'DotBot',
    patterns: ['dotbot'],
    category: 'search',
  },

  // ── Outils de prévisualisation / SEO ────────────────────────────────────────

  {
    name:     'iframely',
    patterns: ['iframely'],
    category: 'preview',
  },
  {
    name:     'W3C Validator',
    patterns: ['w3c_validator'],
    category: 'preview',
  },
  {
    name:     'Rogerbot',
    patterns: ['rogerbot'],
    category: 'preview',
  },
  {
    name:     'AhrefsBot',
    patterns: ['ahrefsbot'],
    category: 'preview',
  },
  {
    name:     'SEMrushBot',
    patterns: ['semrushbot'],
    category: 'preview',
  },
  {
    name:     'MJ12Bot',
    patterns: ['mj12bot'],
    category: 'preview',
  },

  // ── Archiveurs / Robots généraux ────────────────────────────────────────────

  {
    name:     'Wayback Machine',
    patterns: ['ia_archiver'],
    category: 'archiver',
  },

  // ── Patterns génériques (en dernier pour éviter les faux positifs) ───────────
  // NB : 'bot' volontairement omis (trop générique, faux positifs possibles)

  {
    name:     'Generic crawler',
    patterns: ['crawler', 'spider'],
    category: 'preview',
  },
];

// ── Résultat HumanVisit réutilisable (pas d'allocation inutile) ───────────────
const HUMAN: HumanVisit = { isBot: false, name: null, pattern: null, category: null };

// ── Fonction principale ────────────────────────────────────────────────────────
/**
 * Analyse le User-Agent et retourne un résultat typé.
 *
 * @example
 * const r = detectBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)');
 * // → { isBot: true, name: 'Facebook', pattern: 'facebookexternalhit', category: 'social' }
 */
export function detectBot(userAgent: string): DetectionResult {
  if (!userAgent) return HUMAN;

  const ua = userAgent.toLowerCase();

  for (const entry of BOT_REGISTRY) {
    for (const pattern of entry.patterns) {
      if (ua.includes(pattern)) {
        return {
          isBot:    true,
          name:     entry.name,
          pattern,
          category: entry.category,
        };
      }
    }
  }

  return HUMAN;
}

// ── Helpers booléens pratiques ────────────────────────────────────────────────

/** Vrai pour tout bot (social + search + preview + archiver) */
export function isAnyBot(ua: string): boolean {
  return detectBot(ua).isBot;
}

/** Vrai uniquement pour les bots de réseaux sociaux (WhatsApp, Facebook, Telegram…) */
export function isSocialBot(ua: string): boolean {
  const r = detectBot(ua);
  return r.isBot && r.category === 'social';
}

/** Vrai pour les moteurs de recherche (Google, Bing…) */
export function isSearchBot(ua: string): boolean {
  const r = detectBot(ua);
  return r.isBot && r.category === 'search';
}

/** Vrai pour tous les bots qui ont besoin de métadonnées OG (social + search) */
export function needsOGResponse(ua: string): boolean {
  const r = detectBot(ua);
  return r.isBot && (r.category === 'social' || r.category === 'search');
}
