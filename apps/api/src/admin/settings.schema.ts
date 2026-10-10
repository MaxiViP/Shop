import { z } from 'zod';

const money = z.number().int().min(1).max(100_000_000);
export const settingsSchema = z.strictObject({
  weightToleranceBps: z.number().int().min(0).max(5000).optional(),
  customerResponseMinutes: z.number().int().min(1).max(120).optional(),
  minDeliverySubtotal: z.number().int().min(0).max(100_000_000).optional(),
  maxOrderExtraUnitPrice: money.optional(),
  maxOrderExtrasTotal: money.optional(),
  deliveryEnabled: z.boolean().optional(),
  pickupEnabled: z.boolean().optional(),
  freeDeliveryEnabled: z.boolean().optional(),
  freeDeliveryThreshold: money.nullable().optional(),
  queueThreshold: z.number().int().min(1).max(100).optional(),
  assemblyFallbackMinutes: z.number().int().min(5).max(180).optional(),
  assemblyConcurrency: z.number().int().min(1).max(30).optional(),
  peakAssemblyConcurrency: z.number().int().min(1).max(30).optional(),
  peakAssemblyMinutes: z.number().int().min(5).max(180).optional(),
  peakQueueThreshold: z.number().int().min(1).max(100).optional(),
  peakSlotCapacity: z.number().int().min(1).max(30).optional(),
  peakModeEnabled: z.boolean().optional(),
  peakModeStart: z.string().datetime().nullable().optional(),
  peakModeEnd: z.string().datetime().nullable().optional(),
  slotIntervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
  slotCapacity: z.number().int().min(1).max(30).optional(),
  partner1Name: z.string().trim().min(1).max(80).optional(),
  partner2Name: z.string().trim().min(1).max(80).optional(),
});
export type SettingsInput = z.infer<typeof settingsSchema>;
