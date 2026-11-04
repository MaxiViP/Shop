import { z } from 'zod';
import { idSchema, productFilters } from './schema.js';

export const BULK_LIMIT = 1000;
export const bulkSelection = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ids'),
    ids: z
      .array(idSchema)
      .min(1)
      .max(BULK_LIMIT)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Товары не должны повторяться',
      ),
  }),
  z.strictObject({ kind: z.literal('filter'), filter: productFilters }),
]);
export const bulkPreviewSchema = z.strictObject({
  selection: bulkSelection,
  mode: z.literal('global'),
});
export const bulkApplySchema = z.strictObject({
  previewToken: z.string().min(1).max(32000),
  requestId: z.uuid(),
  confirmed: z.literal(true),
});
export const bulkResultSchema = z.object({
  requestId: z.uuid(),
  count: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  globalPercent: z.number().int().min(0).max(100),
  appliedAt: z.iso.datetime(),
  productIds: z.array(idSchema),
});
export const bulkClaims = bulkPreviewSchema.extend({
  version: z.literal(1),
  actorId: idSchema,
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BulkPreviewInput = z.infer<typeof bulkPreviewSchema>;
export type BulkApplyInput = z.infer<typeof bulkApplySchema>;
export type BulkResult = z.infer<typeof bulkResultSchema>;
export type BulkClaims = z.infer<typeof bulkClaims>;
