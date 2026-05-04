import { Types } from 'mongoose';
import ShopVisit from '@/models/shop-visit.model';

export interface DayCount    { date: string;   count: number; }
export interface SourceCount { source: string; count: number; }

export interface ShopVisitStats {
  totalVisits:     number;
  uniqueVisitors:  number;
  visitsToday:     number;
  visitsThisMonth: number;
  visitsPerDay:    DayCount[];
  visitsBySource:  SourceCount[];
}

export async function getShopVisitStats(shopId: string): Promise<ShopVisitStats> {
  const now          = new Date();
  const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const last7Days    = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

  const [result] = await ShopVisit.aggregate([
    { $match: { shopId: new Types.ObjectId(shopId) } },
    {
      $facet: {
        totalVisits:     [{ $count: 'n' }],
        uniqueVisitors:  [{ $group: { _id: '$visitorId' } }, { $count: 'n' }],
        visitsToday:     [{ $match: { visitedAt: { $gte: startOfDay } } },    { $count: 'n' }],
        visitsThisMonth: [{ $match: { visitedAt: { $gte: startOfMonth } } }, { $count: 'n' }],
        visitsPerDay: [
          { $match: { visitedAt: { $gte: last7Days } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$visitedAt' } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        visitsBySource: [
          { $group: { _id: { $ifNull: ['$source', 'direct'] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
      },
    },
  ]);

  const rawPerDay: { _id: string; count: number }[] = result.visitsPerDay ?? [];
  const perDayMap = new Map(rawPerDay.map((d: { _id: string; count: number }) => [d._id, d.count]));

  const visitsPerDay: DayCount[] = [];
  for (let i = 6; i >= 0; i--) {
    const d   = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    visitsPerDay.push({ date: key, count: perDayMap.get(key) ?? 0 });
  }

  const visitsBySource: SourceCount[] = (result.visitsBySource ?? []).map(
    (s: { _id: string; count: number }) => ({ source: s._id, count: s.count })
  );

  return {
    totalVisits:     result.totalVisits[0]?.n     ?? 0,
    uniqueVisitors:  result.uniqueVisitors[0]?.n  ?? 0,
    visitsToday:     result.visitsToday[0]?.n     ?? 0,
    visitsThisMonth: result.visitsThisMonth[0]?.n ?? 0,
    visitsPerDay,
    visitsBySource,
  };
}
