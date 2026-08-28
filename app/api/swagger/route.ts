import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get('key') ?? '';
  const expected = process.env.SWAGGER_ACCESS_KEY;

  if (!expected || key !== expected) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const filePath = path.join(process.cwd(), 'public', 'swagger.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const spec = JSON.parse(raw);
    return NextResponse.json(spec, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'swagger.json introuvable' }, { status: 500 });
  }
}
