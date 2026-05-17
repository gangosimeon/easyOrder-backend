import { ImageResponse } from 'next/og';
import { getShopOGData, isImageUrl, formatPrice } from '@/lib/shop-og';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

// ── Cache HTTP côté réponse ──────────────────────────────────────────────────
const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
};

const W = 1200;
const H = 630;

// ── Fallback image ───────────────────────────────────────────────────────────
function fallbackImage() {
  return new ImageResponse(
    <div
      style={{
        width: `${W}px`, height: `${H}px`,
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '16px',
      }}
    >
      <div style={{ fontSize: '80px' }}>🏪</div>
      <div style={{ color: 'white', fontSize: '32px', fontWeight: 700 }}>
        JeCréeMaBoutique
      </div>
    </div>,
    { width: W, height: H, headers: CACHE_HEADERS }
  );
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const data = await getShopOGData(params.slug);
  if (!data) return fallbackImage();

  const coverColor  = data.coverColor || '#a04343';
  const description = (data.description || `Boutique en ligne`).slice(0, 110);
  const productsWithImg = data.products.filter(p => isImageUrl(p.image)).slice(0, 4);

  // ── Couleurs ────────────────────────────────────────────────────────────────
  // Génère une overlay légèrement plus sombre pour la lisibilité
  const overlayAlpha = 'cc'; // 80% opacité

  return new ImageResponse(
    <div
      style={{
        width: `${W}px`, height: `${H}px`,
        background: `${coverColor}`,
        display: 'flex', flexDirection: 'column',
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Gradient overlay pour la lisibilité */}
      <div style={{
        position: 'absolute', inset: '0',
        background: `linear-gradient(160deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, rgba(0,0,0,0.6) 100%)`,
        display: 'flex',
      }} />

      {/* ── HEADER : Logo + Nom + Description ──────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '28px',
        padding: '40px 52px 28px',
        position: 'relative', zIndex: 1,
      }}>
        {/* Logo */}
        <div style={{
          width: '96px', height: '96px', borderRadius: '22px',
          background: 'rgba(255,255,255,0.15)',
          border: '2.5px solid rgba(255,255,255,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', flexShrink: 0,
          backdropFilter: 'blur(8px)',
        }}>
          {isImageUrl(data.logo)
            ? <img src={data.logo} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: '52px', lineHeight: 1 }}>{data.logo || '🏪'}</span>
          }
        </div>

        {/* Texte */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '44px', fontWeight: 900, color: 'white',
            lineHeight: 1.1, letterSpacing: '-0.5px',
            textShadow: '0 2px 12px rgba(0,0,0,0.4)',
          }}>
            {data.name}
          </div>
          <div style={{
            fontSize: '19px', color: 'rgba(255,255,255,0.82)',
            lineHeight: 1.45, maxWidth: '680px',
          }}>
            {description}
          </div>
          {data.address && (
            <div style={{
              fontSize: '15px', color: 'rgba(255,255,255,0.6)',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <span>📍</span>
              <span>{data.address}</span>
            </div>
          )}
        </div>

        {/* Branding */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
          gap: '3px', flexShrink: 0,
        }}>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>
            propulsé par
          </div>
          <div style={{ fontSize: '16px', fontWeight: 900, color: 'rgba(255,255,255,0.9)' }}>
            JeCréeMaBoutique
          </div>
        </div>
      </div>

      {/* Séparateur */}
      <div style={{
        height: '1px', background: 'rgba(255,255,255,0.18)',
        margin: '0 52px', position: 'relative', zIndex: 1,
      }} />

      {/* ── PRODUITS ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: '16px',
        padding: '24px 52px 32px',
        flex: 1, position: 'relative', zIndex: 1,
      }}>
        {productsWithImg.length > 0 ? (
          <>
            {productsWithImg.map((p, i) => (
              <div key={i} style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                background: 'rgba(255,255,255,0.12)',
                borderRadius: '16px', overflow: 'hidden',
                border: '1.5px solid rgba(255,255,255,0.22)',
              }}>
                <img
                  src={p.image}
                  style={{ width: '100%', height: '160px', objectFit: 'cover' }}
                />
                <div style={{
                  padding: '10px 12px 12px',
                  display: 'flex', flexDirection: 'column', gap: '5px',
                }}>
                  <div style={{
                    fontSize: '14px', fontWeight: 700, color: 'white',
                    lineHeight: 1.25,
                    overflow: 'hidden',
                    display: '-webkit-box',
                  }}>
                    {p.name.slice(0, 28)}{p.name.length > 28 ? '…' : ''}
                  </div>
                  <div style={{
                    fontSize: '15px', fontWeight: 800,
                    color: '#fbbf24',
                  }}>
                    {formatPrice(p.price)}
                  </div>
                </div>
              </div>
            ))}

            {/* Slots vides si moins de 4 produits */}
            {productsWithImg.length < 4 &&
              Array(4 - productsWithImg.length).fill(0).map((_, i) => (
                <div key={`ph-${i}`} style={{
                  flex: 1, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: '16px',
                  border: '1.5px dashed rgba(255,255,255,0.15)',
                }}>
                  <span style={{ fontSize: '36px', opacity: 0.25 }}>🛍️</span>
                </div>
              ))
            }
          </>
        ) : (
          /* Aucune image produit → grand fond stylisé */
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: '12px',
          }}>
            <div style={{
              fontSize: '88px', fontWeight: 900,
              color: 'rgba(255,255,255,0.08)',
              letterSpacing: '-2px',
            }}>
              {data.name}
            </div>
            <div style={{
              fontSize: '18px', color: 'rgba(255,255,255,0.5)', fontWeight: 600,
            }}>
              Boutique en ligne · Commander via WhatsApp
            </div>
          </div>
        )}
      </div>
    </div>,
    { width: W, height: H, headers: CACHE_HEADERS }
  );
}
