import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { registerSchema } from '@/validators/auth.validator';
import { registerUser } from '@/services/auth.service';
import { checkRateLimit, getClientIp } from '@/lib/tracking-guard';

export async function POST(req: Request) {
  try {
    await connectDB();

    // Limite la création de comptes en masse depuis une même IP.
    if (await checkRateLimit(`register:ip:${getClientIp(req)}`, 10, 60 * 60_000)) {
      return res.tooManyRequests();
    }

    const body = await req.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const { user, token, refreshToken } = await registerUser(parsed.data);
    return res.created({ user, token, refreshToken });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 409) return res.conflict(e.message ?? 'Conflit');
    return res.serverError();
  }
}
