import { z } from 'zod';

export const extraSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    comment: z.string().trim().max(1000).nullable().optional(),
    quantity: z.number().int().min(1).max(10000),
    unitPrice: z.number().int().min(1).max(2147483647),
  })
  .strict();
export const editExtraSchema = extraSchema.extend({
  version: z.number().int().positive(),
});
export const cancelExtraSchema = z
  .object({ version: z.number().int().positive() })
  .strict();
export type ExtraInput = z.infer<typeof extraSchema>;
