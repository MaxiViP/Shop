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
    sort: productSortSchema.default('recommended'),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(60).default(24),
    ids,
  })
  .strict()
  .transform((query) => ({
    ...query,
    ids: query.ids ? [...new Set(query.ids)] : undefined,
  }));

export type ProductQuery = z.infer<typeof productQuerySchema>;
export type ProductSort = z.infer<typeof productSortSchema>;
