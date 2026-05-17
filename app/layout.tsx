import type { ReactNode }  from 'react';
import type { Metadata, Viewport } from 'next';

const BASE_URL    = (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://easyorder-backend-wnku.onrender.com').replace(/\/$/, '');
const ANGULAR_URL = (process.env.FRONTEND_URL         ?? 'https://www.jecreemaboutique.com').replace(/\/$/, '');

// ── Metadata globale (héritée / écrasée par generateMetadata des sous-pages) ──
export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),

  title: {
    default:  'JeCréeMaBoutique',
    template: '%s | JeCréeMaBoutique',
  },
  description:
    'JeCréeMaBoutique — Créez et gérez votre boutique en ligne en Afrique. ' +
    'Commandez facilement via WhatsApp.',

  // ── Open Graph global (écrasé page par page) ──────────────────────────────
  openGraph: {
    type:     'website',
    siteName: 'JeCréeMaBoutique',
    locale:   'fr_FR',
    url:      ANGULAR_URL,
    title:    'JeCréeMaBoutique',
    description:
      'Créez et gérez votre boutique en ligne. Commandez via WhatsApp.',
    images: [
      {
        url:    `${BASE_URL}/api/og/default`,
        width:  1200,
        height: 630,
        alt:    'JeCréeMaBoutique — Boutiques en ligne africaines',
        type:   'image/png',
      },
    ],
  },

  // ── Twitter / X global ────────────────────────────────────────────────────
  twitter: {
    card:        'summary_large_image',
    site:        '@jecreemaboutique',
    creator:     '@jecreemaboutique',
    title:       'JeCréeMaBoutique',
    description: 'Créez et gérez votre boutique en ligne. Commandez via WhatsApp.',
  },

  // ── Canonical ─────────────────────────────────────────────────────────────
  alternates: {
    canonical: ANGULAR_URL,
  },

  // ── Robots ────────────────────────────────────────────────────────────────
  // Le backend Next.js n'est pas destiné à être indexé (Angular est la vraie UI)
  robots: {
    index:  false,
    follow: false,
  },
};

// ── Viewport séparé (obligatoire Next.js 14.2+) ───────────────────────────────
export const viewport: Viewport = {
  width:        'device-width',
  initialScale: 1,
  themeColor:   '#e8521a',
};

// ── Root Layout ────────────────────────────────────────────────────────────────
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" dir="ltr">
      <head>
        {/* Préconnexion aux CDN utilisés pour les images OG */}
        <link rel="preconnect" href="https://res.cloudinary.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body
        style={{
          margin:     0,
          padding:    0,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#fafafa',
        }}
      >
        {children}
      </body>
    </html>
  );
}
