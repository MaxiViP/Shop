import { z } from 'zod';

export const researchReview = z.strictObject({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']),
  marketPointId: z.number().int().positive().nullable(),
  productId: z.number().int().positive().nullable(),
  confirmedSku: z.string().min(1).nullable(),
  notes: z.string().nullable(),
  reviewedOn: z.iso.date().nullable(),
});

export const researchReviewPatch = z.strictObject({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => value.status !== undefined || value.notes !== undefined, {
  message: 'Не указаны изменения',
});

export type ResearchReviewPatch = z.infer<typeof researchReviewPatch>;
