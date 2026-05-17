/** @type {import('next').NextConfig} */
const nextConfig = {
  // Autoriser les images externes pour la génération OG (Cloudinary, etc.)
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: '**.cloudinary.com' },
      { protocol: 'https', hostname: '**.amazonaws.com' },
      { protocol: 'https', hostname: '**.imgur.com' },
    ],
  },

  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          // { key: 'Access-Control-Allow-Origin',  value: process.env.FRONTEND_URL || 'http://localhost:4200' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type,Authorization' },
        ],
      },
      {
        // Cache des images OG : 1h côté client, 24h stale
        source: '/api/og/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
        ],
      },
    ];
  },
};

export default nextConfig;
