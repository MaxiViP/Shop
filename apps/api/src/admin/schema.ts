import { z } from 'zod';
import { MAX_QTY, quantityErrors } from '../order/assembly.js';

export const idSchema = z.coerce.number().int().positive().max(2_147_483_647);
const name = z.string().trim().min(1).max(160);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug: латинские буквы, цифры и дефисы');
const sort = z.number().int().min(-1_000_000).max(1_000_000);
const qty = z.number().int().positive().max(MAX_QTY);
export const pricePreviewSchema = z.strictObject({ price: z.number().int().positive().max(100_000_000) });
export const priceStatusSchema = z.enum(['ESTIMATED', 'SOURCE', 'AUDITED']);
const productFields = z.strictObject({
  name,
  slug,
  description: z.string().trim().max(10000).nullable(),
  price: z.number().int().positive().max(100_000_000),
  priceStatus: priceStatusSchema.optional(),
  settlementMode: z.enum(['UNSET', 'SHARED_MARKUP', 'NO_MARKUP']).optional(),
  basePrice: z.number().int().positive().max(100_000_000).nullable().optional(),
  priceQty: qty,
  unit: z.enum(['GRAM', 'PIECE', 'BUNCH', 'PACK']),
  step: qty,
  min: qty,
  portionQty: qty,
  categoryId: z.number().int().positive(),
  marketPointId: idSchema.nullable().optional(),
  sourceUrl: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional(),
  sourceCheckedAt: z.iso.datetime().nullable().optional(),
  active: z.boolean(),
  sort,
  isSeasonal: z.boolean().optional(),
  hitMode: z.enum(['AUTO', 'MANUAL', 'OFF']).optional(),
  seasonalMode: z.enum(['AUTO', 'MANUAL', 'OFF']).optional(),
  seasonTemplateId: idSchema.nullable().optional(),
  seasonalStartsAt: z.iso.datetime().nullable().optional(),
  seasonalEndsAt: z.iso.datetime().nullable().optional(),
});
export const productSchema = productFields.superRefine((data, ctx) => {
  if (data.seasonalMode === 'AUTO' && !data.seasonTemplateId)
    ctx.addIssue({ code: 'custom', path: ['seasonTemplateId'], message: 'Выберите шаблон сезонности.' });
  for (const [field, message] of Object.entries(quantityErrors(data)))
    ctx.addIssue({ code: 'custom', path: [field], message });
  if (data.seasonalStartsAt && data.seasonalEndsAt && data.seasonalEndsAt <= data.seasonalStartsAt)
    ctx.addIssue({ code: 'custom', path: ['seasonalEndsAt'], message: 'Окончание сезонности должно быть позже начала.' });
});
// Cross-field validation uses the merged current product inside the transaction.
export const productPatch = productFields.partial();
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
  marketPoint: idSchema.optional(),
  priceStatus: priceStatusSchema.optional(),
  active: z.enum(['true', 'false']).optional(),
  hitMode: z.enum(['AUTO', 'MANUAL', 'OFF']).optional(),
  seasonTemplateId: idSchema.optional(),
  settlementMode: z.enum(['UNSET', 'SHARED_MARKUP', 'NO_MARKUP']).optional(),
});
export const userQuery = pageSchema.extend({
  role: z.enum(['USER', 'SELLER', 'ADMIN']).optional(),
});
export type ProductInput = z.infer<typeof productSchema>;
export type CategoryInput = z.infer<typeof categorySchema>;
export type ProductQuery = z.infer<typeof productQuery>;
export type UserQuery = z.infer<typeof userQuery>;
