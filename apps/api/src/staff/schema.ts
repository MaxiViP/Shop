import { z } from 'zod';
import { phone as normalizePhone } from '../common/phone.js';

export const itemSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('PICKED'),

    actualQty: z.number().int().positive().max(1_000_000),
  }),

  z.object({
    status: z.literal('MISSING'),
  }),

  z.object({
    status: z.literal('PENDING'),
  }),
]);

const optional = (max: number) => z.string().trim().min(1).max(max).optional();

const trackingUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'Ссылка должна использовать HTTP или HTTPS',
  })
  .optional();

const courierPhone = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .transform((value, ctx) => {
    try {
      return normalizePhone(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Некорректный номер телефона',
      });

      return z.NEVER;
    }
  })
  .optional();

export const deliverySchema = z
  .object({
    provider: z.enum(['YANDEX', 'OTHER']),
    trackingUrl,
    externalOrderId: optional(100),
    courierName: optional(100),
    courierPhone,
    price: z.number().int().nonnegative().max(100_000_000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.provider === 'YANDEX') {
      if (!data.trackingUrl) {
        ctx.addIssue({
          code: 'custom',
          path: ['trackingUrl'],
          message: 'Для Яндекс Доставки укажите HTTPS-ссылку',
        });
      } else if (new URL(data.trackingUrl).protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['trackingUrl'],
          message: 'Ссылка Яндекс Доставки должна использовать HTTPS',
        });
      }
    }

    if (data.provider === 'OTHER') {
      if (!data.courierName) {
        ctx.addIssue({
          code: 'custom',
          path: ['courierName'],
          message: 'Укажите имя курьера',
        });
      }

      if (!data.courierPhone) {
        ctx.addIssue({
          code: 'custom',
          path: ['courierPhone'],
          message: 'Укажите телефон курьера',
        });
      }
    }
  });

export type ItemInput = z.infer<typeof itemSchema>;

export type DeliveryInput = z.infer<typeof deliverySchema>;
