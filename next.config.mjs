/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Standalone output : requis pour Docker (image ~80% plus petite) ──────────
  // Compatible avec `next start` — n'impacte pas le déploiement Render/Vercel.
  output: 'standalone',

  // ── Images externes autorisées ────────────────────────────────────────────────
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com'  },
      { protocol: 'https', hostname: '**.cloudinary.com'   },
      { protocol: 'https', hostname: '**.amazonaws.com'    },
      { protocol: 'https', hostname: '**.imgur.com'        },
    ],
  },

  async headers() {
    // const frontendUrl = process.env.FRONTEND_URL || 'https://www.jecreemaboutique.com';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';

    return [
      // ── CORS pour les routes API ────────────────────────────────────────────
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin',      value: frontendUrl },
          { key: 'Access-Control-Allow-Methods',     value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
          { key: 'Access-Control-Allow-Headers',     value: 'Content-Type,Authorization' },
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
        ],
      },

      // ── Cache CDN long pour les images OG ──────────────────────────────────
      {
        source: '/api/og/:path*',
        headers: [
          { key: 'Cache-Control',             value: 'public, max-age=3600, stale-while-revalidate=86400' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
        ],
      },

      // ── Headers sécurité pour les pages SSR shop (servies aux bots/crawlers
      //    uniquement — un vrai visiteur est redirigé vers l'app Angular) ─────
      {
        source: '/shop/:slug*',
        headers: [
          { key: 'Cache-Control',          value: 'public, max-age=0, must-revalidate' },
          { key: 'X-Frame-Options',        value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
        ],
      },

      // ── CSP pour la doc Swagger (nécessite unpkg.com pour l'UI CDN) ─────────
      {
        source: '/swagger',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
