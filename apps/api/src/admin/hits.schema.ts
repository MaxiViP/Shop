import { z } from 'zod';
import { idSchema, pageSchema } from './schema.js';

export const hitSettingsSchema = z.strictObject({
  periodDays: z.number().int().min(1).max(365),
  minOrders: z.number().int().min(1).max(1_000_000),
  shareBps: z.number().int().min(1).max(10_000),
});
export const hitModeSchema = z.enum(['AUTO', 'MANUAL', 'OFF']);
export const hitQuery = pageSchema.extend({ category: idSchema.optional(), hitMode: hitModeSchema.optional() });
export const hitAssignment = z.strictObject({
  ids: z.array(idSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  hitMode: hitModeSchema,
});
export type HitAssignment = z.infer<typeof hitAssignment>;
export type HitSettingsInput = z.infer<typeof hitSettingsSchema>;
export type HitQuery = z.infer<typeof hitQuery>;
