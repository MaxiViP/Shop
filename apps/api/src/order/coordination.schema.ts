import { z } from 'zod';
export const recordId = z.coerce.number().int().positive();
export const decisionSchema = z.strictObject({
  version: z.number().int().positive(),
  action: z.enum([
    'ACCEPT_ACTUAL',
    'REQUEST_REDUCE',
    'REMOVE_ITEM',
    'ACCEPT_REPLACEMENT',
    'CANCEL_ORDER',
  ]),
});
export const proposalSchema = z.strictObject({
  version: z.number().int().positive(),
  productId: z.number().int().positive(),
  qty: z.number().int().min(1).max(1000000),
});
export const chatSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
});
export const cursorSchema = z
  .object({
    after: recordId.optional(),
    before: recordId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .refine((value) => !(value.after && value.before));
export const readSchema = z.strictObject({ through: z.number().int().min(0) });
