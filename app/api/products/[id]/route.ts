import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { updateProductSchema } from '@/validators/product.validator';
import {
  getProductById,
  updateProduct,
  deleteProduct,
} from '@/services/product.service';

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);
    const product = await getProductById(params.id, authUser.userId);
    return res.ok(product);
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
    const parsed = updateProductSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const product = await updateProduct(params.id, authUser.userId, parsed.data);
    return res.ok(product);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 400) return res.badRequest(e.message ?? 'Erreur');
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
    await deleteProduct(params.id, authUser.userId);
    return res.ok({ message: 'Produit supprimé' });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 404) return res.notFound(e.message);
    return res.serverError();
  }
}
