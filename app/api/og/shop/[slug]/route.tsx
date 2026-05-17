/**
 * /api/og/shop/[slug] — Génération d'image Open Graph Premium
 *
 * Runtime   : Edge (déploiement global, cold start < 50ms)
 * Dimensions: 1200 × 630 px (standard OG pour tous les réseaux sociaux)
 * Police    : Inter (400 / 700 / 900) — chargée 1× par worker, depuis Google Fonts
 *
 * Design "Premium Split" inspiré Shopify / Vercel / Stripe :
 *   ┌─────────────────────────────────┬───────────────────────────┐
 *   │  GAUCHE 620px — Brand identity  │  DROITE 580px — Catalogue │
 *   │  Fond sombre (coverColor grad)  │  Fond clair #F5F5F7       │
 *   │  Logo · Verified badge          │                           │
 *   │  Nom boutique (large, 900)      │  ┌───────┐ ┌───────┐     │
 *   │  Description                    │  │ Prod1 │ │ Prod2 │     │
 *   │  Adresse                        │  │ image │ │ image │     │
 *   │  [N produits] [N catégories]    │  │ prix  │ │ prix  │     │
 *   │  jecreemaboutique.com           │  └───────┘ └───────┘     │
 *   │                                 │  ┌───────┐ ┌───────┐     │
 *   │                                 │  │ Prod3 │ │ Prod4 │     │
 *   │                                 │  │ image │ │ image │     │
 *   │                                 │  │ prix  │ │ prix  │     │
 *   │                                 │  └───────┘ └───────┘     │
 *   └─────────────────────────────────┴───────────────────────────┘
 *
 * Badges dynamiques :
 *   • -XX%    → si product.promotion > 0
 *   • Barré   → si product.originalPrice présent
 *
 * Performance :
 *   • Fonts   : module-level Promise (1 fetch/cold start)
 *   • Données : fetch interne avec next:{revalidate:3600}
 *   • HTTP    : Cache-Control public, max-age=3600, stale-while-revalidate=86400
 */

import { ImageResponse } from 'next/og';
import { ogFonts }       from '@/lib/og-fonts';
import type { NextRequest } from 'next/server';

// ── Edge runtime : cold starts rapides, déploiement mondial ───────────────────
export const runtime = 'edge';

// ── Dimensions OG standard ────────────────────────────────────────────────────
const W = 1200;
const H = 630;

// ── Cache CDN ─────────────────────────────────────────────────────────────────
const CDN_CACHE = 'public, max-age=3600, stale-while-revalidate=86400';

// ── URL de base (injectée au build) ──────────────────────────────────────────
const BASE_URL =
  (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://easyorder-backend-wnku.onrender.com')
    .replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────
interface ProductItem {
  name:           string;
  price:          number;
  originalPrice?: number;
  promotion?:     number;    // pourcentage 0-100
  image?:         string;
  inStock?:       boolean;
  createdAt?:     string;
}

interface ShopApiData {
  company: {
    name:         string;
    description?: string;
    address?:     string;
    logo?:        string;
    coverColor?:  string;
  };
  products:   ProductItem[];
  categories: Array<{ name: string }>;
}

// ── Utilitaires couleurs (pas de Node.js, compatible edge) ────────────────────
function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace(/^#/, '');
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return isNaN(r + g + b) ? null : [r, g, b];
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  return rgb
    ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
    : `rgba(160,67,67,${alpha})`;
}

function darken(hex: string, f: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#111111';
  return `rgb(${Math.round(rgb[0] * f)},${Math.round(rgb[1] * f)},${Math.round(rgb[2] * f)})`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const isUrl   = (s?: string) => !!s && (s.startsWith('http://') || s.startsWith('https://'));
const fmtPrice = (n: number) => new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';

function nameSize(name: string): number {
  if (name.length > 32) return 30;
  if (name.length > 24) return 36;
  if (name.length > 16) return 43;
  return 50;
}

// Prix affiché après réduction (si promotion %)
function effectivePrice(p: ProductItem): number {
  if (p.promotion && p.promotion > 0 && p.originalPrice) {
    return Math.round(p.originalPrice * (1 - p.promotion / 100));
  }
  return p.price;
}

// ── Fetch données boutique depuis l'API publique ──────────────────────────────
async function fetchShopData(slug: string): Promise<ShopApiData | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/public/shop/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      // Cache Next.js côté fetch (ISR-like même en edge)
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const json: { success: boolean; data?: ShopApiData } = await res.json();
    return json.data ?? null;
  } catch {
    return null;
  }
}

// ── Composant : carte produit ─────────────────────────────────────────────────
function ProductCard({ p }: { p: ProductItem }) {
  const hasPromo    = (p.promotion ?? 0) > 0;
  const showBarred  = hasPromo && !!p.originalPrice;
  const displayed   = effectivePrice(p);

  return (
    <div
      style={{
        flex:          1,
        display:       'flex',
        flexDirection: 'column',
        background:    'white',
        borderRadius:  '12px',
        overflow:      'hidden',
        border:        '1px solid #E5E5E5',
        position:      'relative',
      }}
    >
      {/* Image produit */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <img
          src={p.image!}
          style={{
            width:      '100%',
            height:     '162px',
            objectFit:  'cover',
            display:    'block',
          }}
        />

        {/* Badge promotion */}
        {hasPromo ? (
          <div
            style={{
              position:     'absolute',
              top:          '8px',
              right:        '8px',
              background:   '#EF4444',
              borderRadius: '6px',
              padding:      '3px 8px',
              display:      'flex',
              alignItems:   'center',
            }}
          >
            <span style={{ fontSize: '11px', fontWeight: 800, color: 'white' }}>
              -{p.promotion}%
            </span>
          </div>
        ) : null}

        {/* Badge "NOUVEAU" si < 7 jours */}
        {!hasPromo && p.createdAt &&
          Date.now() - new Date(p.createdAt).getTime() < 7 * 86_400_000 ? (
          <div
            style={{
              position:     'absolute',
              top:          '8px',
              left:         '8px',
              background:   '#3B82F6',
              borderRadius: '6px',
              padding:      '3px 9px',
              display:      'flex',
              alignItems:   'center',
            }}
          >
            <span style={{ fontSize: '10px', fontWeight: 700, color: 'white', letterSpacing: '0.5px' }}>
              NOUVEAU
            </span>
          </div>
        ) : null}
      </div>

      {/* Infos produit */}
      <div
        style={{
          padding:       '10px 12px 12px',
          display:       'flex',
          flexDirection: 'column',
          gap:           '5px',
          flex:          1,
        }}
      >
        <div
          style={{
            fontSize:   '13px',
            fontWeight: 700,
            color:      '#1A1A1A',
            lineHeight: 1.3,
          }}
        >
          {p.name.length > 34 ? p.name.slice(0, 34) + '…' : p.name}
        </div>

        {/* Prix + barré */}
        <div
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '8px',
          }}
        >
          <span
            style={{
              fontSize:      '17px',
              fontWeight:    900,
              color:         '#F59E0B',
              letterSpacing: '-0.2px',
            }}
          >
            {fmtPrice(displayed)}
          </span>

          {showBarred ? (
            <span
              style={{
                fontSize:       '11px',
                fontWeight:     400,
                color:          '#9CA3AF',
                textDecoration: 'line-through',
              }}
            >
              {fmtPrice(p.originalPrice!)}
            </span>
          ) : null}
        </div>

        {/* Dot stock */}
        <div
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '5px',
          }}
        >
          <div
            style={{
              width:        '5px',
              height:       '5px',
              borderRadius: '50%',
              background:   p.inStock !== false ? '#22C55E' : '#EF4444',
              flexShrink:   0,
            }}
          />
          <span
            style={{
              fontSize:   '10px',
              fontWeight: 400,
              color:      '#9CA3AF',
            }}
          >
            {p.inStock !== false ? 'En stock' : 'Rupture'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Composant : slot vide ─────────────────────────────────────────────────────
function EmptySlot() {
  return (
    <div
      style={{
        flex:           1,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        flexDirection:  'column',
        gap:            '8px',
        background:     '#EFEFEF',
        borderRadius:   '12px',
        border:         '1.5px dashed #D4D4D4',
      }}
    >
      <span style={{ fontSize: '24px', opacity: 0.25 }}>🛍️</span>
      <span style={{ fontSize: '11px', color: '#C0C0C0', fontWeight: 500 }}>À venir</span>
    </div>
  );
}

// ── Image de fallback ─────────────────────────────────────────────────────────
function buildFallback(fonts: Awaited<typeof ogFonts>) {
  return new ImageResponse(
    <div
      style={{
        width:      `${W}px`,
        height:     `${H}px`,
        background: 'linear-gradient(135deg, #09090B 0%, #18181B 60%, #09090B 100%)',
        display:    'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap:        '20px',
        fontFamily: '"Inter", system-ui, sans-serif',
        position:   'relative',
      }}
    >
      {/* Glow */}
      <div
        style={{
          position: 'absolute',
          inset:    '0',
          background:
            'radial-gradient(ellipse 55% 55% at 50% 50%, rgba(232,82,26,0.18) 0%, transparent 70%)',
          display: 'flex',
        }}
      />
      <div style={{ fontSize: '72px', position: 'relative' }}>🏪</div>
      <div
        style={{
          fontSize:      '40px',
          fontWeight:    900,
          color:         'white',
          letterSpacing: '-0.8px',
          position:      'relative',
        }}
      >
        JeCréeMaBoutique
      </div>
      <div
        style={{
          fontSize:  '17px',
          color:     'rgba(255,255,255,0.38)',
          position:  'relative',
          fontWeight: 400,
        }}
      >
        La boutique en ligne africaine
      </div>
    </div>,
    { width: W, height: H, fonts, headers: { 'Cache-Control': CDN_CACHE } }
  );
}

// ── Route handler principal ───────────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const [shopData, fonts] = await Promise.all([
    fetchShopData(params.slug),
    ogFonts,
  ]);

  if (!shopData?.company) return buildFallback(fonts);

  const shop  = shopData.company;
  const allProducts = shopData.products ?? [];
  const cats  = shopData.categories ?? [];

  // Les 4 premiers produits avec image valide
  const products = allProducts
    .filter(p => isUrl(p.image))
    .slice(0, 4);

  // Couleur de marque (validée)
  const coverColor = /^#[0-9a-fA-F]{6}$/.test(shop.coverColor ?? '')
    ? shop.coverColor!
    : '#a04343';

  const darkBase    = darken(coverColor, 0.30);
  const description = (shop.description ?? 'Boutique en ligne · Commandez via WhatsApp').slice(0, 88);
  const nSize       = nameSize(shop.name ?? '');

  return new ImageResponse(
    <div
      style={{
        width:      `${W}px`,
        height:     `${H}px`,
        display:    'flex',
        flexDirection: 'row',
        fontFamily: '"Inter", system-ui, sans-serif',
        overflow:   'hidden',
      }}
    >

      {/* ════════════════════════════════════════════════════════════════════
          PANNEAU GAUCHE (620px) — Identité boutique
          Fond sombre avec gradient de la couleur de marque
          ════════════════════════════════════════════════════════════════════ */}
      <div
        style={{
          width:      '620px',
          height:     `${H}px`,
          background: `linear-gradient(148deg, ${darkBase} 0%, #0A0A0A 100%)`,
          display:    'flex',
          flexDirection: 'column',
          padding:    '48px 46px 40px',
          position:   'relative',
          overflow:   'hidden',
        }}
      >
        {/* Glow radial top-left (lumière ambiante de la marque) */}
        <div
          style={{
            position:   'absolute',
            inset:      '0',
            background: `radial-gradient(ellipse 75% 65% at 5% 10%, ${rgba(coverColor, 0.22)} 0%, transparent 60%)`,
            display:    'flex',
          }}
        />
        {/* Glow bottom-right */}
        <div
          style={{
            position:   'absolute',
            inset:      '0',
            background: `radial-gradient(ellipse 45% 40% at 95% 95%, ${rgba(coverColor, 0.12)} 0%, transparent 55%)`,
            display:    'flex',
          }}
        />

        {/* ── Logo + Badge vérifié ──────────────────────────────────────── */}
        <div
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '16px',
            marginBottom: '28px',
            position:   'relative',
          }}
        >
          {/* Logo */}
          <div
            style={{
              width:          '78px',
              height:         '78px',
              borderRadius:   '18px',
              background:     `linear-gradient(145deg, ${rgba(coverColor, 0.28)}, ${rgba(coverColor, 0.10)})`,
              border:         `2px solid ${rgba(coverColor, 0.45)}`,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              overflow:       'hidden',
              flexShrink:     0,
            }}
          >
            {isUrl(shop.logo)
              ? <img src={shop.logo!} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontSize: '44px', lineHeight: 1 }}>{shop.logo || '🏪'}</span>
            }
          </div>

          {/* Badge "Boutique Vérifiée" */}
          <div
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          '6px',
              background:   'rgba(34,197,94,0.10)',
              border:       '1px solid rgba(34,197,94,0.22)',
              borderRadius: '100px',
              padding:      '5px 14px',
            }}
          >
            <div
              style={{
                width:        '6px',
                height:       '6px',
                borderRadius: '50%',
                background:   '#22c55e',
                flexShrink:   0,
              }}
            />
            <span
              style={{
                fontSize:      '11px',
                fontWeight:    700,
                color:         '#22c55e',
                letterSpacing: '0.4px',
              }}
            >
              BOUTIQUE VÉRIFIÉE
            </span>
          </div>
        </div>

        {/* ── Nom de la boutique ─────────────────────────────────────────── */}
        <div
          style={{
            fontSize:      `${nSize}px`,
            fontWeight:    900,
            color:         '#FFFFFF',
            lineHeight:    1.05,
            letterSpacing: '-0.5px',
            marginBottom:  '14px',
            position:      'relative',
          }}
        >
          {shop.name}
        </div>

        {/* ── Description ────────────────────────────────────────────────── */}
        <div
          style={{
            fontSize:     '17px',
            fontWeight:   400,
            color:        'rgba(255,255,255,0.68)',
            lineHeight:   1.55,
            marginBottom: shop.address ? '10px' : '0',
            maxWidth:     '510px',
            position:     'relative',
          }}
        >
          {description}
        </div>

        {/* ── Adresse ────────────────────────────────────────────────────── */}
        {shop.address ? (
          <div
            style={{
              display:    'flex',
              alignItems: 'center',
              gap:        '6px',
              position:   'relative',
            }}
          >
            <span style={{ fontSize: '14px' }}>📍</span>
            <span style={{ fontSize: '13px', fontWeight: 400, color: 'rgba(255,255,255,0.40)' }}>
              {shop.address}
            </span>
          </div>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* ── Pills de statistiques ──────────────────────────────────────── */}
        <div
          style={{
            display:      'flex',
            gap:          '8px',
            marginBottom: '16px',
            position:     'relative',
            flexWrap:     'wrap',
          }}
        >
          {/* Nombre de produits */}
          {allProducts.length > 0 ? (
            <div
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          '6px',
                background:   rgba(coverColor, 0.14),
                border:       `1px solid ${rgba(coverColor, 0.24)}`,
                borderRadius: '100px',
                padding:      '6px 14px',
              }}
            >
              <span style={{ fontSize: '13px', fontWeight: 800, color: rgba(coverColor, 0.95) }}>
                {allProducts.length}
              </span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: 'rgba(255,255,255,0.50)' }}>
                produit{allProducts.length > 1 ? 's' : ''}
              </span>
            </div>
          ) : null}

          {/* Nombre de catégories */}
          {cats.length > 0 ? (
            <div
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          '6px',
                background:   'rgba(255,255,255,0.06)',
                border:       '1px solid rgba(255,255,255,0.10)',
                borderRadius: '100px',
                padding:      '6px 14px',
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 500, color: 'rgba(255,255,255,0.42)' }}>
                {cats.length} catégorie{cats.length > 1 ? 's' : ''}
              </span>
            </div>
          ) : null}

          {/* Produits en promo */}
          {allProducts.filter(p => (p.promotion ?? 0) > 0).length > 0 ? (
            <div
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          '5px',
                background:   'rgba(239,68,68,0.12)',
                border:       '1px solid rgba(239,68,68,0.22)',
                borderRadius: '100px',
                padding:      '6px 14px',
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#EF4444' }}>🏷️</span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(239,68,68,0.85)' }}>
                Promotions
              </span>
            </div>
          ) : null}
        </div>

        {/* ── Footer branding ─────────────────────────────────────────────── */}
        <div
          style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            position:       'relative',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 400, color: 'rgba(255,255,255,0.25)' }}>
            jecreemaboutique.com
          </span>
          <span
            style={{
              fontSize:      '10px',
              fontWeight:    700,
              color:         rgba(coverColor, 0.55),
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
            }}
          >
            E-commerce Africain
          </span>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          PANNEAU DROIT (580px) — Grille produits 2×2
          Fond clair Apple-Store / Shopify style pour mettre les images en valeur
          ════════════════════════════════════════════════════════════════════ */}
      <div
        style={{
          width:      '580px',
          height:     `${H}px`,
          background: '#F5F5F7',
          display:    'flex',
          flexDirection: 'column',
          padding:    '20px',
        }}
      >
        {/* Label catalogue */}
        <div
          style={{
            fontSize:      '10px',
            fontWeight:    700,
            color:         rgba(coverColor, 0.75),
            letterSpacing: '2.5px',
            textTransform: 'uppercase',
            marginBottom:  '12px',
          }}
        >
          CATALOGUE
        </div>

        {/* Grille 2 × 2 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Ligne 1 */}
          <div style={{ flex: 1, display: 'flex', gap: '10px' }}>
            {products[0] ? <ProductCard p={products[0]} /> : <EmptySlot />}
            {products[1] ? <ProductCard p={products[1]} /> : <EmptySlot />}
          </div>
          {/* Ligne 2 */}
          <div style={{ flex: 1, display: 'flex', gap: '10px' }}>
            {products[2] ? <ProductCard p={products[2]} /> : <EmptySlot />}
            {products[3] ? <ProductCard p={products[3]} /> : <EmptySlot />}
          </div>
        </div>
      </div>

    </div>,
    { width: W, height: H, fonts, headers: { 'Cache-Control': CDN_CACHE } }
  );
}
