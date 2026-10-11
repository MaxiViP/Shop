import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { researchReview, type ResearchReviewPatch } from './research-drafts.schema.js';

const datasetId = 'bagrationovsky-2026-10-11';

@Injectable()
export class ResearchDraftsService {
  constructor(private readonly db: DbService) {}

  async list() {
    const [stores, products] = await this.db.$transaction([
      this.db.researchStoreDraft.findMany({
        where: { datasetId },
        orderBy: { key: 'asc' },
      }),
      this.db.researchProductDraft.findMany({
        where: { datasetId },
        orderBy: { key: 'asc' },
      }),
    ]);
    return { datasetId, stores, products, customerVisible: false, orderable: false };
  }

  async storeReview(key: string, patch: ResearchReviewPatch) {
    const draft = await this.db.researchStoreDraft.findFirst({
      where: { key, datasetId },
    });
    if (!draft) throw new NotFoundException('Черновик торговой точки не найден');
    const review = researchReview.parse(draft.review);
    return this.db.researchStoreDraft.update({
      where: { key },
      data: {
        review: {
          ...review,
          ...patch,
          reviewedOn: new Date().toISOString().slice(0, 10),
        },
      },
    });
  }

  async productReview(key: string, patch: ResearchReviewPatch) {
    const draft = await this.db.researchProductDraft.findFirst({
      where: { key, datasetId },
    });
    if (!draft) throw new NotFoundException('Черновик товара не найден');
    const review = researchReview.parse(draft.review);
    return this.db.researchProductDraft.update({
      where: { key },
      data: {
        review: {
          ...review,
          ...patch,
          reviewedOn: new Date().toISOString().slice(0, 10),
        },
      },
    });
  }
}
