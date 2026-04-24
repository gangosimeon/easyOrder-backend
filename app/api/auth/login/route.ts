import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { loginSchema } from '@/validators/auth.validator';
import { loginUser } from '@/services/auth.service';

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const { user, token } = await loginUser(parsed.data);
    return res.ok({ user, token });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) return res.unauthorized(e.message);
    return res.serverError();
  }
}
