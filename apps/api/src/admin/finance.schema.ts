import { z } from 'zod';
import { dateSchema } from './schedule.schema.js';
export const financeQuerySchema = z.object({
  period: z.enum(['today', 'yesterday', 'week', 'month', 'previousMonth', 'custom']).default('today'),
  from: dateSchema.optional(), to: dateSchema.optional(),
});
export const payoutSchema = z.strictObject({
  partner: z.number().int().min(1).max(2),
  periodFrom: dateSchema, periodTo: dateSchema,
  amount: z.number().int().refine(value => value !== 0 && Math.abs(value) <= 2_147_483_647),
  paidAt: z.iso.datetime(), comment: z.string().trim().max(500).nullable(),
  idempotencyKey: z.uuid(),
}).refine(data => data.periodFrom <= data.periodTo, 'Некорректный период');
export type FinanceQuery = z.infer<typeof financeQuerySchema>;
export type PayoutInput = z.infer<typeof payoutSchema>;
