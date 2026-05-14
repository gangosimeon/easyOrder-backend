import { connectDB } from '@/lib/db';
import { getAuthUser, signToken } from '@/lib/auth';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';

export async function POST(req: Request) {
  try {
    await connectDB();

    const authUser = getAuthUser(req);
    if (!authUser) {
      return res.unauthorized();
    }

    // Récupérer l'utilisateur complet
    const user = await User.findById(authUser.userId).lean();
    if (!user) {
      return res.notFound('Utilisateur introuvable');
    }

    // Générer un nouveau token
    const newToken = signToken(authUser);

    // Retourner le nouveau token et les données utilisateur
    return res.ok({
      token: newToken,
      user: {
        id: user._id.toString(),
        name: user.name,
        phone: user.phone,
        slug: user.slug,
        description: user.description,
        logo: user.logo,
        address: user.address,
        coverColor: user.coverColor,
        role: user.role,
      },
    });
  } catch (err: unknown) {
    console.error('[POST /api/auth/refresh]', err);
    return res.serverError();
  }
}
