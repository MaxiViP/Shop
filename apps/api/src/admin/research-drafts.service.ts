import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  storeReview(key: string, patch: ResearchReviewPatch, actorId?: number) {
    return this.db.$transaction(async db => {
      const rows = await db.$queryRaw<{ key: string }[]>`SELECT key FROM "ResearchStoreDraft" WHERE key = ${key} AND "datasetId" = ${datasetId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Черновик торговой точки не найден');
      const draft = await db.researchStoreDraft.findUniqueOrThrow({ where: { key } });
      const { expectedUpdatedAt, ...fields } = patch;
      if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== draft.updatedAt.getTime())
        throw new ConflictException('Черновик уже изменён. Обновите данные и проверьте решение.');
      const review = researchReview.parse(draft.review);
      const next = { ...review, ...fields, reviewedOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()) };
      const saved = await db.researchStoreDraft.update({ where: { key }, data: { review: next, updatedAt: new Date(Math.max(Date.now(), draft.updatedAt.getTime() + 1)) } });
      if (actorId) await db.adminAudit.create({ data: {
        actorId, action: 'RESEARCH_REVIEW_CHANGED', entity: 'ResearchStoreDraft', entityId: key,
        oldValue: review, newValue: next,
      } });
      return saved;
    });
  }

  productReview(key: string, patch: ResearchReviewPatch, actorId?: number) {
    return this.db.$transaction(async db => {
      const rows = await db.$queryRaw<{ key: string }[]>`SELECT key FROM "ResearchProductDraft" WHERE key = ${key} AND "datasetId" = ${datasetId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Черновик товара не найден');
      const draft = await db.researchProductDraft.findUniqueOrThrow({ where: { key } });
      const { expectedUpdatedAt, ...fields } = patch;
      if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== draft.updatedAt.getTime())
        throw new ConflictException('Черновик уже изменён. Обновите данные и проверьте решение.');
      const review = researchReview.parse(draft.review);
      const next = { ...review, ...fields, reviewedOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()) };
      const saved = await db.researchProductDraft.update({ where: { key }, data: { review: next, updatedAt: new Date(Math.max(Date.now(), draft.updatedAt.getTime() + 1)) } });
      if (actorId) await db.adminAudit.create({ data: {
        actorId, action: 'RESEARCH_REVIEW_CHANGED', entity: 'ResearchProductDraft', entityId: key,
        oldValue: review, newValue: next,
      } });
      return saved;
    });
  }

}
