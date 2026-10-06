import { z } from 'zod';

export const marketSlug = z.string().trim().min(1).max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Используйте латинские буквы, цифры и дефисы');
export const floorQuery = z.object({
  floor: z.coerce.number().int().min(1).max(20).default(2),
});
const pointFields = z.strictObject({
  slug: marketSlug,
  name: z.string().trim().min(1).max(160),
  unitNumber: z.string().trim().max(40).nullable().optional(),
  kind: z.enum(['STALL', 'STORE', 'FOODCOURT', 'SERVICE', 'OTHER', 'ENTRY']),
  description: z.string().trim().max(3000).nullable().optional(),
  sampleAssortment: z.string().trim().max(2000).nullable().optional(),
  floor: z.number().int().min(1).max(20),
  mapX: z.number().min(0).max(100),
  mapY: z.number().min(0).max(100),
  isPublished: z.boolean(),
  sortOrder: z.number().int().min(-1000000).max(1000000),
});
export const pointSchema = pointFields.extend({
  floor: pointFields.shape.floor.default(2),
  isPublished: pointFields.shape.isPublished.default(false),
  sortOrder: pointFields.shape.sortOrder.default(0),
});
export const pointPatch = pointFields.partial().refine(
  data => Object.keys(data).length > 0, 'Укажите изменения',
);
export type PointInput = z.infer<typeof pointSchema>;
