import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

const optional = (max: number) => z.string().trim().max(max).optional();

export const addressSchema = z.object({
  label: text(30),
  city: text(100),
  street: text(150),
  house: text(30),

  flat: optional(20),
  entrance: optional(20),
  floor: optional(20),
  intercom: optional(30),
  comment: optional(300),

  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  fiasId: optional(100),

  isDefault: z.boolean().optional(),
});

export const addressUpdateSchema = addressSchema
  .omit({
    isDefault: true,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Нет данных для изменения');

export type AddressInput = z.infer<typeof addressSchema>;

export type AddressUpdate = z.infer<typeof addressUpdateSchema>;
