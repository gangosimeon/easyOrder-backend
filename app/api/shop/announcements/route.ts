import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { getActiveAnnouncementsForShop } from '@/services/admin-announcement.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    const data = await getActiveAnnouncementsForShop(authUser.userId);
    return res.ok(data);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}
