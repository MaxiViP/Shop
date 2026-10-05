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
  requestId: z.string().uuid().optional(),
});
export const chatPostSchema = chatSchema.required({ requestId: true });
export const imageChatSchema = z.strictObject({
  text: z.string().trim().max(2000).default(''),
  issueId: z.coerce.number().int().positive().optional(),
  evidence: z.enum(['true', 'false']).optional(),
  requestId: z.string().uuid().optional(),
});
export const imageRevisionSchema = z.strictObject({
  text: z.string().trim().max(2000).default(''),
  requestId: z.string().uuid(),
});
export const cursorSchema = z
  .object({
    after: recordId.optional(),
    before: recordId.optional(),
    around: recordId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
    seen: z.string().max(6000).regex(/^\d+(,\d+)*$/).optional(),
  })
  .refine((value) => [value.after, value.before, value.around].filter(Boolean).length <= 1);
export const readSchema = z.strictObject({
  through: z.number().int().min(0),
  revisionThrough: recordId.optional(),
});
