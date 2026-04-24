import { connectDB } from '@/lib/db';
import { requireAuthUser } from '@/lib/auth';
import * as res from '@/lib/api-response';
import { createProductSchema } from '@/validators/product.validator';
import { getProductsByShop, createProduct } from '@/services/product.service';

export async function GET(req: Request) {
  try {
    await connectDB();
    const authUser = requireAuthUser(req);

    const { searchParams } = new URL(req.url);
    const categoryId = searchParams.get('categoryId') ?? undefined;

    const products = await getProductsByShop(authUser.userId, categoryId);
    return res.ok(products);
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
    const parsed = createProductSchema.safeParse(body);
    if (!parsed.success) {
      return res.badRequest('Données invalides', parsed.error.flatten().fieldErrors);
    }

    const product = await createProduct(authUser.userId, parsed.data);
    return res.created(product);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.message === 'Non authentifié') return res.unauthorized();
    if (e.status === 400) return res.badRequest(e.message ?? 'Erreur');
    return res.serverError();
  }
}
