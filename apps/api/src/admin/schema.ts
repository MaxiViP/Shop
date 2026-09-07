import { z } from 'zod';

export const idSchema = z.coerce.number().int().positive().max(2_147_483_647);
const name = z.string().trim().min(1).max(160);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug: латинские буквы, цифры и дефисы');
const sort = z.number().int().min(-1_000_000).max(1_000_000);
const qty = z.number().int().positive().max(1_000_000);
export const productSchema = z.strictObject({
  name,
  slug,
  description: z.string().trim().max(10000).nullable(),
  price: z.number().int().positive().max(100_000_000),
  priceQty: qty,
  unit: z.enum(['GRAM', 'PIECE', 'BUNCH', 'PACK']),
  step: qty,
  min: qty,
  categoryId: z.number().int().positive(),
  active: z.boolean(),
  sort,
});
export const productPatch = productSchema.partial();
export const categorySchema = z.strictObject({
  name,
  slug,
  active: z.boolean(),
  sort,
  parentId: z.number().int().positive().nullable(),
});
export const categoryPatch = categorySchema.partial();
export const roleSchema = z.strictObject({ role: z.enum(['USER', 'SELLER']) });
export const imageSchema = z.strictObject({
  alt: z.string().trim().max(300).nullable().optional(),
  sort: sort.optional(),
  visible: z.boolean().optional(),
});
export type ImageInput = z.infer<typeof imageSchema>;
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
});
export const productQuery = pageSchema.extend({
  category: idSchema.optional(),
  active: z.enum(['true', 'false']).optional(),
});
export const userQuery = pageSchema.extend({
  role: z.enum(['USER', 'SELLER', 'ADMIN']).optional(),
});
export type ProductInput = z.infer<typeof productSchema>;
export type CategoryInput = z.infer<typeof categorySchema>;
export type ProductQuery = z.infer<typeof productQuery>;
export type UserQuery = z.infer<typeof userQuery>;
