import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { createCategorySchema } from '@/validators/category.validator';
import { getCategoriesByShop, createCategory } from '@/services/category.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const categories = await getCategoriesByShop(authUser.userId);
    return res.ok(categories);
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
    const parsed = createCategorySchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const category = await createCategory(authUser.userId, parsed.data);
    return res.created(category);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    return res.serverError();
  }
}
