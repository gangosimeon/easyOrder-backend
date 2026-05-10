export interface ShopsFilter {
  search?:   string;
  dateFrom?: string;
  dateTo?:   string;
  status?:   'active' | 'inactive' | 'all';
}

export interface SortParams {
  sortField?: string;
  sortDir?:   'asc' | 'desc';
}

const SORTABLE_FIELDS = new Set([
  'name', 'createdAt', 'slug', 'phone', 'productCount', 'status',
]);

export function resolveSort(params: SortParams): { field: string; dir: 1 | -1 } {
  return {
    field: SORTABLE_FIELDS.has(params.sortField ?? '') ? params.sortField! : 'createdAt',
    dir:   params.sortDir === 'asc' ? 1 : -1,
  };
}

export function buildBaseMatchStage(filter: ShopsFilter): Record<string, unknown> {
  const match: Record<string, unknown> = { role: 'user' };

  if (filter.search?.trim()) {
    match.$or = [
      { name:  { $regex: filter.search.trim(), $options: 'i' } },
      { slug:  { $regex: filter.search.trim(), $options: 'i' } },
      { phone: { $regex: filter.search.trim(), $options: 'i' } },
    ];
  }

  const createdAt: Record<string, Date> = {};
  if (filter.dateFrom) createdAt.$gte = new Date(filter.dateFrom);
  if (filter.dateTo) {
    const end = new Date(filter.dateTo);
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  if (Object.keys(createdAt).length) match.createdAt = createdAt;

  return match;
}
