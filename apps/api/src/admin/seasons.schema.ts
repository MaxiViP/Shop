import { z } from 'zod';
import { idSchema } from './schema.js';

export const seasonSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  group: z.enum(['VEGETABLES', 'FRUITS', 'BERRIES']).nullable().optional(),
  startMonth: z.number().int().min(1).max(12),
  endMonth: z.number().int().min(1).max(12),
  active: z.boolean(),
});
export const seasonPatch = seasonSchema.partial().refine(value => Object.keys(value).length > 0);
export const seasonAssignment = z.strictObject({
  ids: z.array(idSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  seasonalMode: z.enum(['AUTO', 'MANUAL', 'OFF']),
  seasonTemplateId: idSchema.nullable(),
}).refine(value => value.seasonalMode !== 'AUTO' || value.seasonTemplateId !== null, {
  path: ['seasonTemplateId'], message: 'Выберите шаблон для автоматической сезонности.',
});
export type SeasonInput = z.infer<typeof seasonSchema>;
export type SeasonAssignment = z.infer<typeof seasonAssignment>;
