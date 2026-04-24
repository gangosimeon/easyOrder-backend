import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import User from '@/models/user.model';
import Category from '@/models/category.model';
import Product from '@/models/product.model';
import { getActiveAnnoncesByShop } from '@/services/annonce.service';

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  try {
    await connectDB();

    const shop = await User.findOne({ slug: params.slug }).select('-password').lean();
    if (!shop) return res.notFound('Boutique introuvable');

    const shopId = shop._id.toString();

    const [categories, products, announcements] = await Promise.all([
      Category.find({ shopId }).sort({ createdAt: 1 }).lean(),
      Product.find({ shopId }).sort({ createdAt: -1 }).lean(),
      getActiveAnnoncesByShop(shopId),
    ]);

    const company = {
      name:        shop.name,
      slug:        shop.slug,
      phone:       shop.phone,
      description: shop.description,
      address:     shop.address,
      logo:        shop.logo,
      coverColor:  shop.coverColor,
    };

    return res.ok({ company, categories, products, announcements });
  } catch {
    return res.serverError();
  }
}
