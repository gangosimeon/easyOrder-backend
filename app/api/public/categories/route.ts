import { connectDB } from '@/lib/db';
import * as res from '@/lib/api-response';
import Category from '@/models/category.model';

// ── GET /api/public/categories ────────────────────────────────────────────────
// Retourne toutes les catégories distinctes des boutiques actives
// Pas d'authentification requise

export async function GET() {
  try {
    await connectDB();

    const raw = await Category.aggregate([
      // Joindre avec les boutiques pour filtrer les inactives
      {
        $lookup: {
          from:         'users',
          localField:   'shopId',
          foreignField: '_id',
          as:           '_shop',
        },
      },
      { $unwind: '$_shop' },
      {
        $match: {
          '_shop.role':     'user',
          '_shop.isActive': { $ne: false },
        },
      },
      // Dédoublonner par nom de catégorie
      {
        $group: {
          _id:   '$name',
          name:  { $first: '$name' },
          color: { $first: '$color' },
          icon:  { $first: '$icon' },
          count: { $sum: 1 },
        },
      },
      // Les plus fréquentes en premier
      { $sort: { count: -1, name: 1 } },
    ]);

    return res.ok(
      raw.map(c => ({
        name:  String(c.name  ?? ''),
        color: String(c.color ?? '#FF6B35'),
        icon:  String(c.icon  ?? 'inventory_2'),
        count: Number(c.count ?? 0),
      }))
    );
  } catch {
    return res.serverError();
  }
}
