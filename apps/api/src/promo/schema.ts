import { z } from 'zod';
const money = z.number().int().min(0).max(2_147_483_647);
const id = z.number().int().positive().max(2_147_483_647);
export const promoIssueSchema = z.strictObject({
  userId: id, title: z.string().trim().min(1).max(160), type: z.enum(['FIXED', 'PERCENT']),
  amount: money.nullable().default(null),
  percentBps: z.number().int().min(1).max(10000).nullable().default(null),
  maxDiscount: money.positive().nullable().default(null),
  minSubtotal: money.default(0), expiresAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(1000), sourceOrderId: id.nullable().default(null),
}).superRefine((value, ctx) => {
  if ((value.type === 'FIXED' && (!value.amount || value.percentBps !== null || value.maxDiscount !== null)) ||
      (value.type === 'PERCENT' && (value.amount !== null || !value.percentBps || !value.maxDiscount)))
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Укажите сумму либо процент и максимальную скидку' });
  if (Date.parse(value.expiresAt) <= Date.now())
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Срок действия должен быть в будущем' });
});
export const promoQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.coerce.number().int().positive().optional(),
  status: z.enum(['AVAILABLE', 'USED', 'EXPIRED', 'REVOKED']).optional(),
});
export type PromoIssue = z.infer<typeof promoIssueSchema>;
export type PromoQuery = z.infer<typeof promoQuerySchema>;
