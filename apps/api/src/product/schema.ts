import { z } from 'zod';

export const productSortSchema = z.enum([
  'recommended',
  'price_asc',
  'price_desc',
  'newest',
  'name',
]);

const text = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value.trim().replace(/\s+/g, ' ') || undefined
        : value,
    z.string().max(max).optional(),
  );

const ids = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value;

  return value.split(',').map((id) => Number(id));
}, z.array(z.number().int().positive()).max(60).optional());

export const productQuerySchema = z
  .object({
    q: text(100),
    category: text(100),
    marketPoint: text(180),
    sort: productSortSchema.default('recommended'),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(60).default(24),
    ids,
    feed: z.enum(['catalog', 'home']).optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    seed: z.uuid().optional(),
  })
  .strict()
  .refine(query => !query.feed || (query.page === 1 && query.limit <= 24), {
    message: 'Feed pagination uses a cursor and at most 24 products',
  })
  .refine(query => (!query.cursor || !!query.feed) && (!query.seed || query.feed === 'home'), {
    message: 'Cursor and seed require the corresponding feed',
  })
  .transform((query) => ({
    ...query,
    ids: query.ids ? [...new Set(query.ids)] : undefined,
  }));

export type ProductQuery = z.infer<typeof productQuerySchema>;
export type ProductSort = z.infer<typeof productSortSchema>;
