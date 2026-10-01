import { z } from 'zod';
import { dateSchema } from './schedule.schema.js';
import { pageSchema } from './schema.js';
export const ordersQuerySchema = pageSchema.extend({
  number: z.coerce.number().int().positive().optional(),
  phone: z.string().trim().max(30).optional(),
  name: z.string().trim().max(100).optional(),
  from: dateSchema.optional(), to: dateSchema.optional(),
  status: z.enum(['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELED']).optional(),
  type: z.enum(['DELIVERY', 'PICKUP']).optional(),
  paymentStatus: z.enum(['AWAITING', 'REPORTED', 'PAID', 'CANCELED']).optional(),
});
export type OrdersQuery = z.infer<typeof ordersQuerySchema>;
