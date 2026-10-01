import { ConflictException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { PayoutInput } from './finance.schema.js';
@Injectable()
export class PayoutsService {
  constructor(private readonly db: DbService) {}
  list() {
    return this.db.partnerPayout.findMany({ orderBy: { paidAt: 'desc' },
      select: { id: true, partner: true, periodFrom: true, periodTo: true,
        amount: true, paidAt: true, comment: true, createdById: true, createdAt: true } });
  }
  private same(existing: { partner: number; amount: number; periodFrom: Date; periodTo: Date;
    paidAt: Date; comment: string | null }, input: PayoutInput) {
    return existing.partner === input.partner && existing.amount === input.amount &&
      existing.periodFrom.toISOString().slice(0, 10) === input.periodFrom &&
      existing.periodTo.toISOString().slice(0, 10) === input.periodTo &&
      existing.paidAt.getTime() === new Date(input.paidAt).getTime() && existing.comment === input.comment;
  }
  async create(input: PayoutInput, actorId: number) {
    try { return await this.db.$transaction(async db => {
      const existing = await db.partnerPayout.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        if (!this.same(existing, input)) throw new ConflictException('Ключ выплаты уже использован');
        return existing;
      }
      const fingerprint = `${input.partner}:${input.periodFrom}:${input.periodTo}:${input.amount}`;
      await db.$executeRaw`SELECT pg_advisory_xact_lock(704005, hashtext(${fingerprint}))`;
      const retried = await db.partnerPayout.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (retried) {
        if (!this.same(retried, input)) throw new ConflictException('Ключ выплаты уже использован');
        return retried;
      }
      const duplicate = await db.partnerPayout.findFirst({ where: {
        partner: input.partner,
        periodFrom: new Date(`${input.periodFrom}T00:00:00.000Z`),
        periodTo: new Date(`${input.periodTo}T00:00:00.000Z`),
        amount: input.amount,
      } });
      if (duplicate) throw new ConflictException({
        code: 'PAYOUT_DUPLICATE',
        message: 'Такая выплата уже записана. Проверьте историю выплат.',
      });
      const saved = await db.partnerPayout.create({ data: {
        ...input, periodFrom: new Date(`${input.periodFrom}T00:00:00.000Z`),
        periodTo: new Date(`${input.periodTo}T00:00:00.000Z`), paidAt: new Date(input.paidAt),
        createdById: actorId,
      } });
      await db.adminAudit.create({ data: {
        actorId, action: 'PARTNER_PAYOUT_RECORDED', entity: 'PARTNER_PAYOUT',
        entityId: String(saved.id), newValue: {
          partner: saved.partner, periodFrom: input.periodFrom, periodTo: input.periodTo,
          amount: saved.amount, paidAt: saved.paidAt.toISOString(), comment: saved.comment,
        },
      } });
      return saved;
    });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        const existing = await this.db.partnerPayout.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing && this.same(existing, input)) return existing;
        throw new ConflictException('Ключ выплаты уже использован');
      }
      throw error;
    }
  }
}
