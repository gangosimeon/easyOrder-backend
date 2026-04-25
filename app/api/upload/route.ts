// import { NextRequest, NextResponse } from 'next/server';
// import { writeFile, mkdir } from 'fs/promises';
// import path from 'path';
// import { randomUUID } from 'crypto';

// const MAX_SIZE_BYTES = 5 * 1024 * 1024;
// const ALLOWED_TYPES  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// export async function POST(request: NextRequest) {
//   try {
//     const formData = await request.formData();
//     const file = formData.get('file') as File | null;

//     if (!file || !file.size) {
//       return NextResponse.json({ error: 'Aucun fichier fourni' }, { status: 400 });
//     }

//     if (!ALLOWED_TYPES.includes(file.type)) {
//       return NextResponse.json({ error: 'Type de fichier non supporté (jpeg, png, webp, gif uniquement)' }, { status: 400 });
//     }

//     if (file.size > MAX_SIZE_BYTES) {
//       return NextResponse.json({ error: 'Fichier trop lourd (max 5 Mo)' }, { status: 400 });
//     }

//     const bytes  = await file.arrayBuffer();
//     const buffer = Buffer.from(bytes);

//     const ext      = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
//     const filename = `${randomUUID()}.${ext}`;

//     const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
//     await mkdir(uploadsDir, { recursive: true });
//     await writeFile(path.join(uploadsDir, filename), buffer);

//     const baseUrl = (process.env.BACKEND_URL ?? 'https://easyorder-backend-wnku.onrender.com').replace(/\/$/, '');
//     const url     = `${baseUrl}/uploads/${filename}`;

//     return NextResponse.json({ url });
//   } catch (err) {
//     console.error('[upload] error:', err);
//     return NextResponse.json({ error: "Erreur lors de l'upload" }, { status: 500 });
//   }
// }


import { NextRequest, NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';

const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file || !file.size) {
      return NextResponse.json({ error: 'Aucun fichier fourni' }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Type de fichier non supporté (jpeg, png, webp, gif uniquement)' }, { status: 400 });
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: 'Fichier trop lourd (max 5 Mo)' }, { status: 400 });
    }

    const bytes  = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const base64 = `data:${file.type};base64,${buffer.toString('base64')}`;

    const result = await cloudinary.uploader.upload(base64, {
      folder:         'burkina-shop',
      transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    });

    return NextResponse.json({ url: result.secure_url });
  } catch (err) {
    console.error('[upload] error:', err);
    return NextResponse.json({ error: "Erreur lors de l'upload" }, { status: 500 });
  }
}
