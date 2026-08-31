import { z } from 'zod';

export const statusSchema = z.object({
  status: z.enum([
    'NEW',
    'CONFIRMED',
    'ASSEMBLING',
    'READY',
    'DELIVERING',
    'COMPLETED',
    'CANCELED',
  ]),
});

export const itemSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('PICKED'),

    actualQty: z.number().int().positive().max(1_000_000),
  }),

  z.object({
    status: z.literal('MISSING'),
  }),
]);

export type StatusInput = z.infer<typeof statusSchema>;

export type ItemInput = z.infer<typeof itemSchema>;
