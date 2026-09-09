import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { OrderStatus, OrderType, UserRole, Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import type { DeliveryInput, ItemInput } from './schema.js';
import {
  deliveryTotals,
  positiveDeliveryPrice,
  totalWithDelivery,
  goodsLine,
  goodsSum,
} from '../order/pricing.js';
import { checkIssues, syncIssue, issueSummary } from '../order/coordination.js';
import { cancelOrder, restoreOrder, restoreProblem, cancellationHistory } from '../order/cancel.js';
import { NotificationService } from '../order/notification.service.js';
import { paymentSelect, requirePaid } from '../order/payment.js';
import { message } from '../order/coordination.js';
import type { ExtraInput } from './extra.js';


@Injectable()
export class StaffService {
  constructor(private readonly db: DbService, private readonly notifications: NotificationService) {}

  async list(status?: OrderStatus) {
    const orders = await this.db.order.findMany({
      where: status ? { status } : undefined,
      select: {
        cancellations: { ...cancellationHistory, take: 1 },
        assemblyFinalizedAt: true,
        id: true,
        publicId: true,
        type: true,
        status: true,
        issues: issueSummary,
        staffUnread: true,

        customerName: true,
        customerPhone: true,

        city: true,
        street: true,
        house: true,

        deliveryAt: true,

        total: true,
        finalTotal: true,
        finalSubtotal: true,
        payment: { select: paymentSelect },
        createdAt: true,

        delivery: {
          select: {
            externalOrderId: true,
            id: true,
            provider: true,
            status: true,
          },
        },

        items: {
          select: {
            id: true,
            productName: true,
            qty: true,
            unit: true,
            status: true,
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
    return orders.map(order => ({ ...order, restoreProblem: restoreProblem(order, order.cancellations[0]) }));
  }

  async newSummary() {
    const [count, latest] = await this.db.$transaction([
      this.db.order.count({ where: { status: 'NEW' } }),
      this.db.order.findFirst({ where: { status: 'NEW' }, orderBy: { id: 'desc' }, select: { id: true } }),
    ], { isolationLevel: 'RepeatableRead' });
    return { count, latestOrderId: latest?.id ?? null };
  }

  async unread() {
    const total = await this.db.order.aggregate({ _sum: { staffUnread: true } });
    const latest = await this.db.orderChatMessage.findFirst({
      where: { recipient: { in: ['staff', 'both'] }, order: { staffUnread: { gt: 0 } } },
      orderBy: { id: 'desc' }, select: { orderId: true },
    });
    return { count: total._sum.staffUnread ?? 0, latestOrderId: latest?.orderId ?? null };
  }

  async get(id: number) {
    const order = await this.db.order.findUnique({
      where: { id },

      select: {
        cancellations: { ...cancellationHistory, take: 50 },
        extras: { orderBy: { id: 'asc' } },
        id: true,
        publicId: true,
        type: true,
        status: true,

        customerName: true,
        customerPhone: true,

        city: true,
        street: true,
        house: true,
        flat: true,
        entrance: true,
        floor: true,
        intercom: true,
        comment: true,

        deliveryAt: true,

        subtotal: true,
        deliveryPrice: true,
        total: true,
        finalSubtotal: true,
        finalTotal: true,
        weightToleranceBps: true,
        issues: { orderBy: { id: 'asc' } },
        assemblyFinalizedAt: true,
        payment: { select: paymentSelect },

        createdAt: true,
        updatedAt: true,

        delivery: {
          select: {
            provider: true,
            status: true,
            externalOrderId: true,
            trackingUrl: true,
            courierName: true,
            courierPhone: true,
            price: true,
            publicToken: true,
            providerStatus: true,
            syncedAt: true,
          },
        },

        items: {
          select: {
            id: true,

            productName: true,
            productSlug: true,
            image: true,

            price: true,
            priceQty: true,
            unit: true,

            qty: true,
            actualQty: true,

            total: true,
            actualTotal: true,

            status: true,
          },

          orderBy: {
            id: 'asc',
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }

    return { ...order, restoreProblem: restoreProblem(order, order.cancellations[0]) };
  }

  async item(orderId: number, itemId: number, data: ItemInput, userId: number | null = null) {
    const saved = await this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, orderId);

      if (
        order.status !== 'ASSEMBLING' ||
        order.assemblyFinalizedAt ||
        ['REPORTED', 'PAID'].includes(order.payment?.status ?? '')
      ) {
        throw new BadRequestException('Заказ сейчас не собирается');
      }

      const item = await db.orderItem.findFirst({
        where: {
          id: itemId,
          orderId,
        },

      });

      if (!item) {
        throw new NotFoundException('Позиция не найдена');
      }
      const issue = await db.orderIssue.findUnique({ where: { orderItemId: item.id } });
      if (issue?.replacementItemId) throw new ConflictException('Исходный товар уже заменён');
      if (issue?.status === 'RESOLVED' && issue.resolution === 'REMOVE_ITEM') throw new ConflictException('Покупатель убрал этот товар из заказа');
      if (data.status !== 'PENDING' && item.status === data.status && (data.status !== 'PICKED' || item.actualQty === data.actualQty)) return item;

      if (data.status === 'PENDING') {
        if (item.status !== 'PICKED' && item.status !== 'MISSING') {
          throw new BadRequestException('Позиция уже находится в сборке');
        }

        const updated = await db.orderItem.update({
          where: {
            id: item.id,
          },

          data: {
            status: 'PENDING',
            actualQty: null,
            actualTotal: null,
          },
        });
        await syncIssue(db, order, updated, userId);
        return updated;
      }

      if (item.status !== 'PENDING') {
        throw new BadRequestException('Сначала верните позицию в сборку');
      }

      if (data.status === 'MISSING') {
        const updated = await db.orderItem.update({
          where: {
            id: item.id,
          },

          data: {
            status: 'MISSING',
            actualQty: 0,
            actualTotal: 0,
          },
        });
        await syncIssue(db, order, updated, userId);
        return updated;
      }

      const actualTotal = goodsLine(item.price, data.actualQty, item.priceQty);

      const updated = await db.orderItem.update({
        where: {
          id: item.id,
        },

        data: {
          status: 'PICKED',
          actualQty: data.actualQty,
          actualTotal,
        },
      });
      await syncIssue(db, order, updated, userId);
      return updated;
    });
    await this.notifications.dispatch(orderId);
    return saved;
  }

  confirm(id: number) {
    return this.transition(id, 'NEW', 'CONFIRMED');
  }

  startAssembly(id: number) {
    return this.transition(id, 'CONFIRMED', 'ASSEMBLING');
  }

  async finishAssembly(id: number) {
    const saved = await this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

      if (
        order.assemblyFinalizedAt &&
        order.status !== 'CANCELED' &&
        order.payment &&
        order.payment.status !== 'CANCELED'
      )
        return order;

      if (order.status !== 'ASSEMBLING') {
        throw new BadRequestException('Заказ сейчас не собирается');
      }

      const items = await db.orderItem.findMany({ where: { orderId: id } });
      if (!items.length || items.some((item) => item.status === 'PENDING'))
        throw new BadRequestException('Сначала обработайте все товары');
      // Validate quantities before tolerance/approval checks; invalid data is a business error.
      for (const item of items) if (item.status === 'PICKED') goodsLine(item.price, item.actualQty ?? 0, item.priceQty);
      await checkIssues(db, id, items, order.weightToleranceBps);
      const amounts = items.map((item) => {
        if (item.status === 'MISSING') return 0;
        const amount = goodsLine(
          item.price,
          item.actualQty ?? 0,
          item.priceQty,
        );
        return amount;
      });
      const extras = await db.orderExtra.findMany({ where: { orderId: id, status: 'ACTIVE' } });
      const finalSubtotal = goodsSum([...amounts, ...extras.map(extra => goodsLine(extra.unitPrice, extra.quantity, 1))]);
      if (finalSubtotal === 0)
        throw new ConflictException(
          'В заказе нет товаров к оплате. Верните товары в сборку или отмените заказ',
        );
      for (const [index, item] of items.entries())
        await db.orderItem.update({
          where: { id: item.id },
          data: {
            actualTotal: amounts[index]!,
            ...(item.status === 'MISSING' ? { actualQty: 0 } : {}),
          },
        });
      const payment = await db.orderPayment.upsert({
        where: { orderId: id },
        create: { orderId: id, amount: finalSubtotal },
        update: {
          amount: finalSubtotal,
          status: 'AWAITING',
          method: null,
          reportedAt: null,
          confirmedAt: null,
          confirmedById: null,
        },
      });

      await db.orderNotification.create({ data: { orderId: id, type: 'PAYMENT_READY', dedupeKey: `payment:${payment.id}:${payment.updatedAt.toISOString()}` } });
      return db.order.update({
        where: { id },

        data: {
          status: 'READY',
          assemblyFinalizedAt: new Date(),
          finalSubtotal,
          finalTotal: totalWithDelivery(finalSubtotal, order.deliveryPrice),
        },
      });
    });
    await this.notifications.dispatch(id);
    return saved;
  }

  completePickup(id: number) {
    return this.transition(id, 'READY', 'COMPLETED', 'PICKUP');
  }

  async reopen(id: number) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);
      if (
        order.status !== 'READY' ||
        (order.payment &&
          !['AWAITING', 'CANCELED'].includes(order.payment.status)) ||
        order.delivery?.externalOrderId ||
        order.delivery?.provider === 'OTHER'
      )
        throw new ConflictException(
          'Вернуть к сборке можно только до сообщения об оплате и оформления доставки',
        );
      await db.orderPayment.updateMany({
        where: { orderId: id },
        data: { status: 'CANCELED' },
      });
      return db.order.update({
        where: { id },
        data: {
          status: 'ASSEMBLING',
          assemblyFinalizedAt: null,
          finalSubtotal: null,
          finalTotal: null,
        },
      });
    });
  }

  async confirmPayment(id: number, userId: number, type?: OrderType) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);
      if (type && order.type !== type) throw new ConflictException('Неверный способ получения заказа');
      if (order.payment?.status === 'PAID') return order.payment;
      if (
        order.status !== 'READY' ||
        !order.assemblyFinalizedAt ||
        !order.payment || !['AWAITING', 'REPORTED'].includes(order.payment.status) ||
        order.payment.amount !== order.finalSubtotal
      )
        throw new ConflictException(
          'Заказ не готов к оплате или сумма изменилась',
        );
      const payment = await db.orderPayment.update({
        where: { orderId: id },
        data: {
          status: 'PAID',
          confirmedAt: new Date(),
          confirmedById: userId,
        },
        select: paymentSelect,
      });
      await message(db, id, order.type === 'DELIVERY' ? 'Оплата получена. Оформляем доставку.' : 'Оплата получена.', 'SYSTEM', userId, null, 'customer');
      return payment;
    });
  }

  async extra(orderId: number, userId: number, data: ExtraInput | null, id?: number, version?: number) {
    return this.db.$transaction(async db => {
      const order = await this.lockedOrder(db, orderId);
      if (order.status !== 'ASSEMBLING' || order.assemblyFinalizedAt || ['PAID', 'REPORTED'].includes(order.payment?.status ?? ''))
        throw new ConflictException('Услуги можно менять только во время сборки до оплаты');
      const current = id ? await db.orderExtra.findFirst({ where: { id, orderId } }) : null;
      if (id && !current) throw new NotFoundException('Услуга не найдена');
      if (current && (current.version !== version || current.status !== 'ACTIVE')) throw new ConflictException('Услуга изменилась. Обновите заказ');
      if (!data) {
        if (!current) throw new NotFoundException('Услуга не найдена');
        return db.orderExtra.update({ where: { id: current.id }, data: { status: 'CANCELED', canceledAt: new Date(), version: { increment: 1 } } });
      }
      const amount = goodsLine(data.unitPrice, data.quantity, 1);
      const values = { ...data, comment: data.comment || null, amount };
      return current
        ? db.orderExtra.update({ where: { id: current.id }, data: { ...values, version: { increment: 1 } } })
        : db.orderExtra.create({ data: { ...values, orderId, createdById: userId } });
    });
  }

  async cancel(id: number, userId: number | null = null, role: UserRole = 'SELLER', reason?: string) {
    return this.db.$transaction(async db => {
      await this.lockedOrder(db, id);
      return cancelOrder(db, id, userId, role, reason);
    });
  }

  async restore(id: number, userId: number, role: UserRole, cancellationId: number) {
    const saved = await this.db.$transaction(async db => {
      await this.lockedOrder(db, id);
      return restoreOrder(db, id, userId, role, cancellationId);
    });
    await this.notifications.dispatch(id);
    return saved;
  }

  async delivery(id: number, data: DeliveryInput) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);
      requirePaid(order);

      if (order.type !== 'DELIVERY' || order.status !== 'READY') {
        throw new BadRequestException(
          'Доставку можно оформить только для собранного заказа',
        );
      }

      if (data.provider === 'YANDEX') {
        throw new BadRequestException(
          'Яндекс Доставка оформляется через автоматический расчёт',
        );
      }

      if (
        order.delivery?.provider === 'YANDEX' &&
        order.delivery.externalOrderId
      ) {
        throw new BadRequestException('Для заказа уже создана Яндекс Доставка');
      }
      positiveDeliveryPrice(data.price);
      const totals = deliveryTotals(order, data.price);

      if (
        order.delivery &&
        order.delivery.status !== 'PENDING' &&
        order.delivery.status !== 'ASSIGNED'
      ) {
        throw new BadRequestException('Данные доставки уже нельзя изменить');
      }

      const delivery = await db.delivery.upsert({
        where: {
          orderId: id,
        },

        update: {
          provider: data.provider,
          status: 'ASSIGNED',
          externalOrderId: data.externalOrderId ?? null,
          trackingUrl: data.trackingUrl ?? null,
          courierName: data.courierName ?? null,
          courierPhone: data.courierPhone ?? null,
          price: data.price,
          providerStatus: null,
          providerUpdatedAt: null,
          syncedAt: null,
        },

        create: {
          orderId: id,
          provider: data.provider,
          status: 'ASSIGNED',
          externalOrderId: data.externalOrderId,
          trackingUrl: data.trackingUrl,
          courierName: data.courierName,
          courierPhone: data.courierPhone,
          price: data.price,
          publicToken: randomBytes(32).toString('base64url'),
        },
      });

      await db.order.update({
        where: { id },
        data: totals,
      });

      return delivery;
    });
  }

  async handoff(id: number) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);
      requirePaid(order);

      if (order.type !== 'DELIVERY' || order.status !== 'READY') {
        throw new BadRequestException('Заказ нельзя передать курьеру');
      }

      if (
        !order.delivery ||
        order.delivery.provider !== 'OTHER' ||
        order.delivery.status !== 'ASSIGNED' ||
        !this.validDelivery(order.delivery)
      ) {
        throw new BadRequestException('Сначала сохраните данные доставки');
      }

      positiveDeliveryPrice(order.delivery.price);
      const totals = deliveryTotals(order, order.delivery.price);

      const delivery = await db.delivery.update({
        where: {
          id: order.delivery.id,
        },

        data: {
          status: 'PICKED_UP',
        },
      });

      const updatedOrder = await db.order.update({
        where: { id },

        data: {
          status: 'DELIVERING',
          ...totals,
        },
      });

      return {
        order: updatedOrder,
        delivery,
      };
    });
  }

  async completeDelivery(id: number) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

      if (order.type !== 'DELIVERY' || order.status !== 'DELIVERING') {
        throw new BadRequestException('Заказ сейчас не доставляется');
      }

      if (
        !order.delivery ||
        order.delivery.provider !== 'OTHER' ||
        order.delivery.status !== 'PICKED_UP'
      ) {
        throw new BadRequestException('Некорректный статус доставки');
      }

      const delivery = await db.delivery.update({
        where: {
          id: order.delivery.id,
        },

        data: {
          status: 'DELIVERED',
        },
      });

      const updatedOrder = await db.order.update({
        where: { id },

        data: {
          status: 'COMPLETED',
        },
      });

      return {
        order: updatedOrder,
        delivery,
      };
    });
  }

  private async transition(
    id: number,
    current: OrderStatus,
    next: OrderStatus,
    type?: OrderType,
  ) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

      if (current === 'NEW' && next === 'CONFIRMED' && order.status === 'CONFIRMED') return order;
      if (order.status !== current || (type && order.type !== type)) {
        throw new BadRequestException('Недопустимое действие с заказом');
      }

      if (next === 'COMPLETED') requirePaid(order);

      return db.order.update({
        where: { id },
        data: { status: next },
      });
    });
  }

  private async lockedOrder(db: Prisma.TransactionClient, id: number) {
    const rows = await db.$queryRaw<{ id: number }[]>`
      SELECT "id"
      FROM "Order"
      WHERE "id" = ${id}
      FOR UPDATE
    `;

    if (!rows.length) {
      throw new NotFoundException('Заказ не найден');
    }

    const order = await db.order.findUnique({
      where: { id },

      select: {
        id: true,
        type: true,
        status: true,
        deliveryPrice: true,
        subtotal: true,
        finalSubtotal: true,
        weightToleranceBps: true,
        assemblyFinalizedAt: true,
        payment: { select: paymentSelect },

        delivery: {
          select: {
            id: true,
            provider: true,
            status: true,
            trackingUrl: true,
            courierName: true,
            courierPhone: true,
            externalOrderId: true,
            price: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }

    return order;
  }

  private validDelivery(delivery: {
    provider: 'YANDEX' | 'OTHER';
    trackingUrl: string | null;
    courierName: string | null;
    courierPhone: string | null;
  }) {
    return Boolean(delivery.courierName && delivery.courierPhone);
  }
}
