import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

const optional = (max: number) => z.string().trim().max(max).optional();

const addressSchema = z.object({
  city: text(100),
  street: text(150),
  house: text(30),

  flat: optional(20),
  entrance: optional(20),
  floor: optional(20),
  intercom: optional(30),
  comment: optional(300),
});

export const orderSchema = z
  .object({
    type: z.enum(['DELIVERY', 'PICKUP']),

    customerName: text(100),
    customerPhone: text(30),

    address: addressSchema.optional(),

    deliveryAt: z.string().datetime().optional(),

    items: z
      .array(
        z.object({
          productId: z.number().int().positive(),

          qty: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'DELIVERY' && !data.address) {
      ctx.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'Укажите адрес доставки',
      });
    }
  });

export type OrderInput = z.infer<typeof orderSchema>;
