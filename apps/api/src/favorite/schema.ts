import { z } from 'zod';

export const favoriteSyncSchema = z.object({
  productIds: z.array(z.number().int().positive()).max(100),
});

export type FavoriteSyncInput = z.infer<typeof favoriteSyncSchema>;
