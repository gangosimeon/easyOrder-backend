import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getShopOGData, isImageUrl, formatPrice } from '@/lib/shop-og';

const BASE_URL    = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://easyorder-backend-wnku.onrender.com';
const ANGULAR_URL = process.env.FRONTEND_URL         ?? 'https://www.jecreemaboutique.com';

// ── Dynamic OG metadata ──────────────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: { slug: string } }
): Promise<Metadata> {
  const data = await getShopOGData(params.slug);

  if (!data) {
    return {
      title: 'Boutique introuvable',
      description: 'Cette boutique n\'existe pas ou a été supprimée.',
    };
  }

  const ogImageUrl  = `${BASE_URL}/api/og/shop/${params.slug}`;
  const shopUrl     = `${ANGULAR_URL}/shop/${params.slug}`;
  const description = data.description
    || `Découvrez les produits de ${data.name}${data.address ? ` — ${data.address}` : ''}`;

  return {
    metadataBase: new URL(BASE_URL),
    title: `${data.name} | JeCréeMaBoutique`,
    description,
    openGraph: {
      type:        'website',
      url:         shopUrl,
      siteName:    'JeCréeMaBoutique',
      locale:      'fr_FR',
      title:       data.name,
      description,
      images: [
        {
          url:    ogImageUrl,
          width:  1200,
          height: 630,
          alt:    `${data.name} — Boutique en ligne`,
        },
      ],
    },
    twitter: {
      card:        'summary_large_image',
      title:       data.name,
      description,
      images:      [ogImageUrl],
    },
    alternates: {
      canonical: shopUrl,
    },
    robots: {
      index:  false, // Ne pas indexer cette page de proxy
      follow: false,
    },
  };
}

// ── Page component (visible uniquement par les bots) ─────────────────────────

export default async function ShopOGPage(
  { params }: { params: { slug: string } }
) {
  const data = await getShopOGData(params.slug);
  if (!data) redirect(ANGULAR_URL);

  const shopUrl     = `${ANGULAR_URL}/shop/${params.slug}`;
  const description = data.description
    || `Découvrez les produits de ${data.name}`;

  return (
    <main style={{
      fontFamily:  'system-ui, sans-serif',
      maxWidth:    '860px',
      margin:      '0 auto',
      padding:     '40px 20px',
      background:  '#fafafa',
      minHeight:   '100vh',
    }}>
      {/* Shop header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '24px' }}>
        <div style={{
          width: '80px', height: '80px', borderRadius: '20px',
          background: data.coverColor, display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexShrink: 0, overflow: 'hidden',
        }}>
          {isImageUrl(data.logo)
            ? <img src={data.logo} alt={data.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: '40px' }}>{data.logo}</span>
          }
        </div>

        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: '28px', color: '#111' }}>{data.name}</h1>
          <p  style={{ margin: '0 0 4px', color: '#555', lineHeight: 1.5 }}>{description}</p>
          {data.address && (
            <p style={{ margin: 0, color: '#888', fontSize: '14px' }}>📍 {data.address}</p>
          )}
        </div>
      </div>

      {/* Products preview */}
      {data.products.length > 0 && (
        <div>
          <h2 style={{ fontSize: '18px', color: '#333', marginBottom: '16px' }}>Produits disponibles</h2>
          <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '12px', padding: 0, listStyle: 'none', margin: 0 }}>
            {data.products.map((p, i) => (
              <li key={i} style={{
                background: 'white', borderRadius: '12px', overflow: 'hidden',
                border: '1px solid #e5e7eb',
              }}>
                {isImageUrl(p.image) && (
                  <img src={p.image} alt={p.name} style={{ width: '100%', height: '160px', objectFit: 'cover' }} />
                )}
                <div style={{ padding: '12px' }}>
                  <p style={{ margin: '0 0 4px', fontWeight: 700, color: '#111' }}>{p.name}</p>
                  <p style={{ margin: 0, color: '#e8521a', fontWeight: 800 }}>{formatPrice(p.price)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* CTA */}
      <div style={{ marginTop: '32px', textAlign: 'center' }}>
        <a
          href={shopUrl}
          style={{
            display: 'inline-block', padding: '14px 32px',
            background: data.coverColor || '#e8521a', color: 'white',
            textDecoration: 'none', borderRadius: '12px',
            fontWeight: 700, fontSize: '16px',
          }}
        >
          Voir la boutique complète →
        </a>
      </div>
    </main>
  );
}
