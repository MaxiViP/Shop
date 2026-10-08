import { z } from 'zod';
import { escalatorBounds, mapSize, minHitSize } from './geometry.js';

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
  mapX: z.number().min(0).max(100).nullable(),
  mapY: z.number().min(0).max(100).nullable(),
  mapWidth: z.number().min(minHitSize).max(mapSize.width).nullable().optional(),
  mapHeight: z.number().min(minHitSize).max(mapSize.height).nullable().optional(),
  mapColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Укажите HEX-цвет, например #00DC82').transform(value => value.toUpperCase()).nullable().optional(),
  isOurPoint: z.boolean().optional(),
  ourLabel: z.string().trim().max(80).nullable().optional(),
  isPublished: z.boolean(),
  sortOrder: z.number().int().min(-1000000).max(1000000),
});
export const pointSchema = pointFields.extend({
  floor: pointFields.shape.floor.default(2),
  isPublished: pointFields.shape.isPublished.default(false),
  sortOrder: pointFields.shape.sortOrder.default(0),
}).superRefine((data, ctx) => {
  if ((data.mapX === null) !== (data.mapY === null)) ctx.addIssue({ code: 'custom', message: 'Укажите обе координаты или оставьте точку без координат', path: ['mapX'] });
  if ((data.mapWidth == null) !== (data.mapHeight == null)) ctx.addIssue({ code: 'custom', message: 'Укажите ширину и высоту вместе', path: ['mapWidth'] });
  if (data.isOurPoint && ['ENTRY', 'SERVICE'].includes(data.kind)) ctx.addIssue({ code: 'custom', message: 'Нашей точкой может быть торговая точка, а не вход или сервис', path: ['isOurPoint'] });
});
export const pointPatch = pointFields.partial().extend({ expectedUpdatedAt: z.iso.datetime().optional() }).refine(
  data => Object.keys(data).some(key => key !== 'expectedUpdatedAt'), 'Укажите изменения',
);
export type PointInput = z.infer<typeof pointSchema>;
export type PointPatch = z.infer<typeof pointPatch>;

export const escalatorSchema = z.strictObject({
  x: z.number().min(0).max(mapSize.width), y: z.number().min(0).max(mapSize.height),
  width: z.number().min(24).max(mapSize.width), length: z.number().min(60).max(mapSize.height),
  rotation: z.number().min(0).max(359), published: z.boolean(),
}).refine(value => {
  const bounds = escalatorBounds(value);
  return bounds.x >= -0.000001 && bounds.y >= -0.000001 && bounds.x + bounds.width <= mapSize.width + 0.000001
    && bounds.y + bounds.height <= mapSize.height + 0.000001;
}, 'Эскалатор должен целиком находиться в границах схемы');
export const layoutPatch = z.strictObject({ escalator: escalatorSchema.nullable(), expectedUpdatedAt: z.iso.datetime().nullable().optional() });
export type LayoutInput = z.infer<typeof layoutPatch>;
