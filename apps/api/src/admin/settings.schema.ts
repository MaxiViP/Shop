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
});
export type SettingsInput = z.infer<typeof settingsSchema>;
