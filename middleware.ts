
import { NextRequest, NextResponse } from 'next/server';

const allowedOrigins = [
  'https://www.jecreemaboutique.com',
  'https://localhost',
  'http://localhost:4200',
  'http://localhost:4300',
];

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin');
  // ── CORS pour les routes API ────────────────────────────────────────────
  // Traiter les requêtes préflight CORS
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 });

    if (origin && allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Vary', 'Origin');
      response.headers.set(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      );
      response.headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization'
      );
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      response.headers.set('Access-Control-Max-Age', '86400');
    }

    return response;
  }

  const response = NextResponse.next();

  if (origin && allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Expose-Headers', 'Retry-After');
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
