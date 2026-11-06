import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { updateCategorySchema } from '@/validators/category.validator';
import {
  getCategoryById,
  updateCategory,
  deleteCategory,
} from '@/services/category.service';

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);
    const category = await getCategoryById(params.id, authUser.userId);
    return res.ok(category);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);

    const body = await req.json();
    if ('external' in body) {
      return res.badRequest('Le champ external est géré par la synchronisation GestStock et ne peut pas être modifié manuellement.');
    }
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
    if (e.status === 409) return res.conflict(e.message ?? 'Conflit');
    return res.serverError();
  }
}

export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await connectDB();
    const authUser = await requireAuthUser(req);
    await deleteCategory(params.id, authUser.userId);
    return res.ok({ message: 'Catégorie et ses produits supprimés' });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}
