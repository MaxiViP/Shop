import { describe, expect, it } from 'vitest';
import { researchReview, researchReviewPatch } from './research-drafts.schema.js';

const pending = {
  status: 'PENDING' as const,
  marketPointId: null,
  productId: null,
  confirmedSku: null,
  notes: null,
  reviewedOn: null,
};

describe('research drafts review', () => {
  it('accepts the imported pending review without inventing prices or links', () => {
    expect(researchReview.parse(pending)).toEqual(pending);
  });

  it('allows review notes and status updates', () => {
    expect(researchReviewPatch.parse({ status: 'VERIFIED', notes: 'Павильон проверен лично' }))
      .toEqual({ status: 'VERIFIED', notes: 'Павильон проверен лично' });
  });

  it('rejects arbitrary fields, empty patches, and excessively long notes', () => {
    expect(researchReviewPatch.safeParse({ active: true }).success).toBe(false);
    expect(researchReviewPatch.safeParse({}).success).toBe(false);
    expect(researchReviewPatch.safeParse({ notes: 'x'.repeat(2001) }).success).toBe(false);
  });
});
