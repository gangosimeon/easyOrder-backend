/**
 * /shop/[slug]/page.tsx
 *
 * Page SSR servie UNIQUEMENT aux bots (détectés par middleware.ts).
 * Les utilisateurs réels sont redirigés vers Angular avant d'atteindre ce fichier.
 *
 * Contenu de la réponse HTML :
 *  • <head> : meta OG complètes, Twitter Cards, JSON-LD Schema.org
 *  • <body> : aperçu visuel de la boutique (fallback si le bot affiche du HTML)
 *
 * Optimisations par plateforme :
 *  • Facebook / Instagram : og:image min 600×315, siteName, locale
 *  • WhatsApp             : og:image accessible sans auth, og:type website
 *  • Twitter / X          : summary_large_image, creator
 *  • LinkedIn             : og:type website, description ≤ 200 chars
 *  • Discord              : lit twitter: en fallback si og: absent
 *  • Telegram             : lit og: standard
 *  • Slack                : og: standard + og:image:secure_url
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getShopOGData, isImageUrl, formatPrice } from '@/lib/shop-og';
import { detectBot } from '@/lib/bot-detector';

// ── ISR : les données boutique sont revalidées toutes les heures ──────────────
export const revalidate = 3600;

const ANGULAR_URL = (process.env.FRONTEND_URL ?? 'https://www.jecreemaboutique.com').replace(/\/$/, '');

// ── Résout l'URL de base depuis les headers de la requête entrante ─────────────
// Évite de hard-coder l'URL Render (qui a des cold starts) dans les balises og:image.
// Quand le bot fait la requête, on utilise le même host pour l'image OG.
function resolveBaseUrl(): string {
  try {
    const h     = headers();
    const host  = h.get('host') ?? '';
    const proto = h.get('x-forwarded-proto') ?? 'https';
    if (host) return `${proto}://${host}`;
  } catch { /* headers() peut lever hors contexte */ }
  return (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://easyorder-backend-wnku.onrender.com').replace(/\/$/, '');
}

// ── Metadata dynamique (injectées dans <head> par Next.js App Router) ─────────
export async function generateMetadata(
  { params }: { params: { slug: string } }
): Promise<Metadata> {
  const data = await getShopOGData(params.slug);

  if (!data) {
    return {
      title:       'Boutique introuvable | JeCréeMaBoutique',
      description: 'Cette boutique n\'existe pas ou a été supprimée.',
      robots:      { index: false, follow: false },
    };
  }

  const baseUrl  = resolveBaseUrl();
  const ogImage  = `${baseUrl}/api/og/shop/${params.slug}`;
  const shopUrl  = `${ANGULAR_URL}/shop/${params.slug}`;
  const siteDesc = data.description?.trim()
    || `Découvrez les produits de ${data.name}${data.address ? ` — ${data.address}` : ''}. Commandez facilement via WhatsApp.`;

  // LinkedIn préfère ≤ 200 chars
  const shortDesc = siteDesc.length > 200 ? siteDesc.slice(0, 197) + '…' : siteDesc;

  // ── Images OG : grille produits (1200×630) + logo en fallback ─────────────
  // Certains crawlers (Facebook Lite, WhatsApp messages) ont un timeout court.
  // Si la génération de l'image dynamique est trop lente, le logo sert de fallback.
  const ogImages: { url: string; width: number; height: number; alt: string; type?: string }[] = [
    {
      url:    ogImage,
      width:  1200,
      height: 630,
      alt:    `${data.name} — Aperçu boutique et produits`,
      type:   'image/png',
    },
  ];
  if (isImageUrl(data.logo)) {
    ogImages.push({ url: data.logo, width: 400, height: 400, alt: data.name });
  }

  return {
    metadataBase: new URL(baseUrl),

    // ── Titre ──────────────────────────────────────────────────────────────
    title:       `${data.name} | JeCréeMaBoutique`,
    description: shortDesc,

    // ── Open Graph — standard + Facebook / WhatsApp / Telegram / LinkedIn ──
    openGraph: {
      type:        'website',
      url:         shopUrl,
      siteName:    'JeCréeMaBoutique',
      locale:      'fr_FR',
      title:       `${data.name} — Boutique en ligne`,
      description: shortDesc,
      images:      ogImages,
    },

    // ── Twitter / X Cards ─────────────────────────────────────────────────
    twitter: {
      card:        'summary_large_image',
      site:        '@jecreemaboutique',
      creator:     '@jecreemaboutique',
      title:       `${data.name} — Boutique en ligne`,
      description: shortDesc,
      images: [
        { url: ogImage, alt: `${data.name} — Aperçu boutique et produits` },
      ],
    },

    // ── Canonical → Angular (la vraie URL utilisateur) ────────────────────
    alternates: {
      canonical: shopUrl,
    },

    // ── Ne jamais indexer cette page proxy (Angular est la vraie page) ─────
    robots: {
      index:  false,
      follow: false,
    },

    // ── Slack lit og:image:secure_url ─────────────────────────────────────
    other: {
      'og:image:secure_url': ogImage,
    },
  };
}

// ── Composant page (HTML fallback affiché si le bot interprète le body) ───────
export default async function ShopOGPage(
  { params }: { params: { slug: string } }
) {
  const data = await getShopOGData(params.slug);

  // Introuvable → renvoie vers Angular
  if (!data) redirect(ANGULAR_URL);

  // Sécurité : si un vrai utilisateur arrive ici (ex: no-JS, proxy), le renvoyer
  const ua     = headers().get('user-agent') ?? '';
  const result = detectBot(ua);
  if (!result.isBot) redirect(`${ANGULAR_URL}/shop/${params.slug}`);

  const shopUrl    = `${ANGULAR_URL}/shop/${params.slug}`;
  const ogImage    = `${resolveBaseUrl()}/api/og/shop/${params.slug}`;
  const description = data.description?.trim()
    || `Découvrez les produits de ${data.name}. Commandez facilement via WhatsApp.`;

  // ── JSON-LD Schema.org (Store + OfferCatalog) ─────────────────────────────
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type':    'Store',
    name:        data.name,
    description,
    url:         shopUrl,
    image:       isImageUrl(data.logo) ? data.logo : ogImage,
    ...(isImageUrl(data.logo) ? { logo: data.logo } : {}),
    ...(data.address ? {
      address: {
        '@type':        'PostalAddress',
        streetAddress:  data.address,
        addressCountry: 'BF',   // Burkina Faso
      },
    } : {}),
    ...(data.phone ? { telephone: data.phone } : {}),
    ...(data.products.length > 0 ? {
      hasOfferCatalog: {
        '@type': 'OfferCatalog',
        name:    `Catalogue ${data.name}`,
        itemListElement: data.products.slice(0, 6).map((p, i) => ({
          '@type':          'Offer',
          position:          i + 1,
          name:              p.name,
          price:             p.price,
          priceCurrency:    'XOF',
          availability:     'https://schema.org/InStock',
          ...(isImageUrl(p.image) ? { image: p.image } : {}),
        })),
      },
    } : {}),
    // Breadcrumb pour SEO
    breadcrumb: {
      '@type':           'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Accueil',  item: ANGULAR_URL },
        { '@type': 'ListItem', position: 2, name: 'Boutiques',item: `${ANGULAR_URL}/shop` },
        { '@type': 'ListItem', position: 3, name: data.name,  item: shopUrl },
      ],
    },
  };

  // ── Constantes visuelles ──────────────────────────────────────────────────
  const brandColor = /^#[0-9a-fA-F]{6}$/.test(data.coverColor ?? '')
    ? data.coverColor
    : '#e8521a';

  return (
    <>
      {/* JSON-LD dans le <head> */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* ── Page HTML minimaliste (fallback pour bots qui affichent du HTML) ── */}
      <main
        style={{
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          maxWidth:   '820px',
          margin:     '0 auto',
          padding:    '0 20px 60px',
          background: '#f8f8f8',
          minHeight:  '100vh',
          color:      '#111',
        }}
      >
        {/* ── Barre de marque ──────────────────────────────────────────────── */}
        <div
          style={{
            background:    brandColor,
            padding:       '12px 20px',
            marginBottom:  '32px',
            marginLeft:    '-20px',
            marginRight:   '-20px',
            display:       'flex',
            alignItems:    'center',
            justifyContent:'space-between',
          }}
        >
          <span style={{ color: 'white', fontWeight: 800, fontSize: '15px' }}>
            JeCréeMaBoutique
          </span>
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '12px' }}>
            Boutiques en ligne
          </span>
        </div>

        {/* ── En-tête boutique ──────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', marginBottom: '28px' }}>
          {/* Logo */}
          <div
            style={{
              width:          '80px',
              height:         '80px',
              borderRadius:   '18px',
              background:     brandColor,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              overflow:       'hidden',
              flexShrink:     0,
            }}
          >
            {isImageUrl(data.logo)
              ? <img src={data.logo} alt={data.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontSize: '38px' }}>{data.logo || '🏪'}</span>}
          </div>

          <div>
            <h1 style={{ margin: '0 0 6px', fontSize: '26px', fontWeight: 800, lineHeight: 1.2 }}>
              {data.name}
            </h1>
            <p style={{ margin: '0 0 5px', color: '#555', fontSize: '15px', lineHeight: 1.5 }}>
              {description}
            </p>
            {data.address && (
              <p style={{ margin: 0, color: '#888', fontSize: '13px' }}>
                📍 {data.address}
              </p>
            )}
          </div>
        </div>

        {/* ── Aperçu produits ──────────────────────────────────────────────── */}
        {data.products.length > 0 && (
          <section>
            <h2 style={{ fontSize: '17px', fontWeight: 700, marginBottom: '14px', color: '#333' }}>
              Produits disponibles
            </h2>
            <div
              style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap:                 '12px',
              }}
            >
              {data.products.map((p, i) => (
                <div
                  key={i}
                  style={{
                    background:   'white',
                    borderRadius: '12px',
                    overflow:     'hidden',
                    border:       '1px solid #e8e8e8',
                  }}
                >
                  {isImageUrl(p.image) && (
                    <img
                      src={p.image}
                      alt={p.name}
                      loading="lazy"
                      style={{
                        width:      '100%',
                        height:     '160px',
                        objectFit:  'cover',
                        display:    'block',
                      }}
                    />
                  )}
                  <div style={{ padding: '12px' }}>
                    <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: '14px' }}>
                      {p.name}
                    </p>
                    <p style={{ margin: 0, fontWeight: 800, fontSize: '15px', color: brandColor }}>
                      {formatPrice(p.price)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── CTA ─────────────────────────────────────────────────────────── */}
        <div style={{ marginTop: '32px', textAlign: 'center' }}>
          <a
            href={shopUrl}
            style={{
              display:        'inline-block',
              padding:        '14px 36px',
              background:     brandColor,
              color:          'white',
              textDecoration: 'none',
              borderRadius:   '12px',
              fontWeight:     700,
              fontSize:       '16px',
            }}
          >
            Visiter la boutique →
          </a>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <footer style={{ marginTop: '48px', textAlign: 'center', color: '#ccc', fontSize: '12px' }}>
          <a href={ANGULAR_URL} style={{ color: '#ccc', textDecoration: 'none' }}>
            JeCréeMaBoutique
          </a>
          {' · '}La boutique en ligne africaine
        </footer>
      </main>
    </>
  );
}
