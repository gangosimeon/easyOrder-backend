import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { createAnnonceSchema } from '@/validators/annonce.validator';
import { getAnnoncesByShop, createAnnonce } from '@/services/annonce.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const annonces = await getAnnoncesByShop(authUser.userId);
    return res.ok(annonces);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}

export async function POST(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    const body = await req.json();
    const parsed = createAnnonceSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const annonce = await createAnnonce(authUser.userId, parsed.data);
    return res.created(annonce);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}
