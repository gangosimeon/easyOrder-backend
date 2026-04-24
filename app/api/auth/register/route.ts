import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import { registerSchema } from '@/validators/auth.validator';
import { registerUser } from '@/services/auth.service';

export async function POST(req: Request) {
  try {
    await connectDB();

    const body = await req.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const { user, token } = await registerUser(parsed.data);
    return res.created({ user, token });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 409) return res.conflict(e.message ?? 'Conflit');
    return res.serverError();
  }
}
