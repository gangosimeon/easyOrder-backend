import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { refreshSession } from '@/services/auth.service';

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json().catch(() => ({}));
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
    if (!refreshToken) {
      return res.badRequest('refreshToken requis');
    }

    const { user, token, refreshToken: newRefreshToken } = await refreshSession(refreshToken);
    return res.ok({ user, token, refreshToken: newRefreshToken });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) return res.unauthorized(e.message);
    console.error('[POST /api/auth/refresh]', err);
    return res.serverError();
  }
}
