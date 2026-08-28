import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { loginSchema } from '@/validators/auth.validator';
import { loginUser } from '@/services/auth.service';
import { checkRateLimit, getClientIp } from '@/lib/tracking-guard';

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    // Anti brute-force : par IP (net large) et par numéro ciblé (net serré),
    // pour couvrir aussi bien un script automatisé qu'une attaque distribuée
    // visant un seul compte.
    const ip = getClientIp(req);
    if (checkRateLimit(`login:ip:${ip}`, 30, 10 * 60_000)) {
      return res.tooManyRequests();
    }
    if (checkRateLimit(`login:phone:${parsed.data.phone}`, 8, 10 * 60_000)) {
      return res.tooManyRequests();
    }

    const { user, token, refreshToken } = await loginUser(parsed.data);
    return res.ok({ user, token, refreshToken });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) return res.unauthorized(e.message);
    if (e.status === 403) return res.forbidden(e.message);
    console.error('[POST /api/auth/login]', err);
    return res.serverError();
  }
}
