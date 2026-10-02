import { z } from 'zod';
import { MAX_QTY } from '../order/assembly.js';
import { addressSchema } from '../order/schema.js';

const revision = z.string().uuid();
const productId = z.number().int().positive().max(2_147_483_647);
const qty = z.number().int().positive().max(MAX_QTY);
const base = z.object({ revision });

export const cartChangeSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('clear') }),
  base.extend({ kind: z.literal('remove'), productId }),
  base.extend({ kind: z.literal('plus'), productId }),
  base.extend({ kind: z.literal('minus'), productId }),
  base.extend({ kind: z.literal('add'), productId, qty }),
  base.extend({ kind: z.literal('set'), productId, qty }),
]);
export type CartChangeInput = z.infer<typeof cartChangeSchema>;

export const cartMergeSchema = base.extend({
  items: z.array(z.object({ productId, qty })).max(50),
});
export type CartMergeInput = z.infer<typeof cartMergeSchema>;

export const cartCheckoutSchema = base.extend({
  type: z.enum(['DELIVERY', 'PICKUP']),
  customerName: z.string().trim().min(1).max(100),
  customerPhone: z.string().trim().min(1).max(30),
  address: addressSchema.optional(),
  deliveryAt: z.string().datetime().optional(),
  fulfillmentMode: z.enum(['ASAP', 'SCHEDULED']).optional(),
  scheduledFor: z.string().datetime().optional(),
  checkoutRequestId: z.uuid().optional(),
  quoteToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type CartCheckoutInput = z.infer<typeof cartCheckoutSchema>;
