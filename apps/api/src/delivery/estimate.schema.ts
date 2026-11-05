import { z } from 'zod';

export const estimateAddressSchema = z
  .object({
    city: z.string().trim().min(1).max(100),
    street: z.string().trim().min(1).max(150),
    house: z.string().trim().min(1).max(30),
    buildingPart: z.string().trim().max(50).optional(),
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional(),
  })
  .strict()
  .refine(
    (value) => (value.lat === undefined) === (value.lng === undefined),
    'Укажите обе координаты адреса',
  );

export type EstimateAddress = z.infer<typeof estimateAddressSchema>;
