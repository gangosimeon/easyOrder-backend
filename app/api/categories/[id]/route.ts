import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { updateCategorySchema } from '@/validators/category.validator';
import {
  getCategoryById,
  updateCategory,
  deleteCategory,
} from '@/services/category.service';

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const category = await getCategoryById(params.id, authUser.userId);
    return res.ok(category);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    const body = await req.json();
    const parsed = updateCategorySchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const category = await updateCategory(params.id, authUser.userId, parsed.data);
    return res.ok(category);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    await deleteCategory(params.id, authUser.userId);
    return res.ok({ message: 'Catégorie et ses produits supprimés' });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}
