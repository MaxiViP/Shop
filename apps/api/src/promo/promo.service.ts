import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma, PromoCode } from '../db/gen/client.js';
import { discountAmount } from './promo.js';
import type { PromoIssue, PromoQuery } from './schema.js';
const publicSelect = {
  id: true, code: true, title: true, type: true, amount: true, percentBps: true,
  maxDiscount: true, minSubtotal: true, expiresAt: true, status: true, usedAt: true,
  usedOrder: { select: { publicId: true } },
} satisfies Prisma.PromoCodeSelect;
type PublicPromo = Prisma.PromoCodeGetPayload<{ select: typeof publicSelect }>;
function status(promo: { status: string; expiresAt: Date }, now = new Date()) {
  return promo.status === 'AVAILABLE' && promo.expiresAt <= now ? 'EXPIRED' : promo.status;
}
function problem(promo: { status: string; expiresAt: Date; minSubtotal: number }, subtotal: number | null) {
  const state = status(promo);
  if (state === 'USED') return 'Промокод уже использован';
  if (state === 'REVOKED') return 'Промокод отозван';
  if (state === 'EXPIRED') return 'Срок действия истёк';
  if (subtotal === null) return 'Проверьте товары в корзине';
  if (subtotal < promo.minSubtotal) return 'Сумма товаров меньше минимальной';
  if (subtotal === 0) return 'Добавьте товары в корзину';
  return null;
}
function present(promo: PublicPromo) { return { ...promo, status: status(promo) }; }
@Injectable()
export class PromoService {
  constructor(private readonly db: DbService) {}
  async mine(userId: number) {
    return (await this.db.promoCode.findMany({ where: { userId }, select: publicSelect,
      orderBy: { id: 'desc' } })).map(present);
  }
  async options(db: Prisma.TransactionClient, userId: number, subtotal: number | null) {
    return (await db.promoCode.findMany({ where: { userId, status: 'AVAILABLE' }, select: publicSelect,
      orderBy: { expiresAt: 'asc' } })).map(promo => ({
        ...present(promo), eligible: !problem(promo, subtotal), reason: problem(promo, subtotal),
        discount: subtotal === null || problem(promo, subtotal) ? 0 : discountAmount(subtotal, promo),
      }));
  }
  async preview(db: Prisma.TransactionClient, userId: number | null, id: number, subtotal: number | null) {
    if (!userId) throw new BadRequestException('Персональный промокод доступен после входа');
    const promo = await db.promoCode.findFirst({ where: { id, userId }, select: publicSelect });
    if (!promo) throw new BadRequestException('Промокод недоступен');
    const reason = problem(promo, subtotal);
    return { ...present(promo), reason, eligible: !reason, discount: reason || subtotal === null ? 0 : discountAmount(subtotal, promo) };
  }
  async redeem(db: Prisma.TransactionClient, userId: number | null, id: number, subtotal: number) {
    await db.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${id} AND "userId" = ${userId ?? -1} FOR UPDATE`;
    const promo = await db.promoCode.findFirst({ where: { id, userId: userId ?? -1 } });
    if (!promo) throw new BadRequestException('Промокод недоступен');
    const reason = problem(promo, subtotal);
    if (reason) throw new ConflictException(reason);
    return { promo, discount: discountAmount(subtotal, promo) };
  }
  async issue(actorId: number, input: PromoIssue) {
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new BadRequestException('Срок действия должен быть в будущем');
    return this.db.$transaction(async db => {
      const user = await db.user.findFirst({ where: { id: input.userId, role: 'USER' }, select: { id: true } });
      if (!user) throw new NotFoundException('Покупатель не найден');
      if (input.sourceOrderId && !await db.order.findFirst({
        where: { id: input.sourceOrderId, userId: user.id }, select: { id: true },
      })) throw new BadRequestException('Исходный заказ должен принадлежать покупателю');
      const promo = await db.promoCode.create({ data: {
        ...input, expiresAt: new Date(input.expiresAt), issuedById: actorId,
        code: 'KM-' + randomBytes(10).toString('hex').toUpperCase(),
      } });
      await db.adminAudit.create({ data: { actorId, action: 'PROMO_ISSUE', entity: 'PromoCode',
        entityId: String(promo.id), newValue: { userId: promo.userId, code: promo.code, reason: promo.reason } } });
      return { ...promo, status: status(promo) };
    });
  }
  async list(query: PromoQuery) {
    const now = new Date();
    const where: Prisma.PromoCodeWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status === 'EXPIRED' ? { status: 'AVAILABLE', expiresAt: { lte: now } }
        : query.status === 'AVAILABLE' ? { status: 'AVAILABLE', expiresAt: { gt: now } }
        : query.status ? { status: query.status } : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.promoCode.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit,
        include: { user: { select: { id: true, name: true, phone: true } },
          usedOrder: { select: { id: true, publicId: true } },
          orders: { select: { id: true, status: true, createdAt: true, promoDiscount: true, finalPromoDiscount: true }, orderBy: { id: 'desc' }, take: 20 } } }),
      this.db.promoCode.count({ where }),
    ]);
    return { items: items.map(promo => ({ ...promo, status: status(promo, now) })), total,
      page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) };
  }
  async revoke(actorId: number, id: number) {
    return this.db.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${id} FOR UPDATE`;
      const promo = await db.promoCode.findUnique({ where: { id } });
      if (!promo) throw new NotFoundException('Промокод не найден');
      if (promo.status === 'REVOKED') return { ...promo, status: status(promo) };
      if (promo.status !== 'AVAILABLE') throw new ConflictException('Использованный промокод нельзя отозвать');
      const saved = await db.promoCode.update({ where: { id }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await db.adminAudit.create({ data: { actorId, action: 'PROMO_REVOKE', entity: 'PromoCode', entityId: String(id),
        oldValue: { status: promo.status }, newValue: { status: saved.status } } });
      return saved;
    });
  }
}
export function promoSnapshot(promo: PromoCode, discount: number) {
  return { promoCodeId: promo.id, promoCodeSnapshot: promo.code, promoTitleSnapshot: promo.title,
    promoTypeSnapshot: promo.type, promoAmountSnapshot: promo.amount, promoPercentBpsSnapshot: promo.percentBps,
    promoMaxDiscountSnapshot: promo.maxDiscount, promoMinSubtotalSnapshot: promo.minSubtotal, promoDiscount: discount };
}
