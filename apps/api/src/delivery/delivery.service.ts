import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { message } from '../order/coordination.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DeliveryStatus, Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { deliveryTotals, positiveDeliveryPrice } from '../order/pricing.js';
import { requirePaid } from '../order/payment.js';
import {
  type YandexClaimInfo,
  type YandexOrderInput,
  YandexRequestError,
  YandexService,
} from './yandex.service.js';

const BOOKING_LEASE_MS = 90_000;

const deliveryRank: Record<Exclude<DeliveryStatus, 'CANCELED'>, number> = {
  PENDING: 0,
  ASSIGNED: 1,
  PICKED_UP: 2,
  DELIVERED: 3,
};

const assignedStatuses = new Set([
  'ready_for_approval',
  'accepted',
  'performer_lookup',
  'performer_draft',
  'performer_found',
  'pickup_arrived',
  'ready_for_pickup_confirmation',
]);

const pickedUpStatuses = new Set([
  'pickuped',
  'delivery_arrived',
  'ready_for_delivery_confirmation',
  'pay_waiting',
  'returning',
  'return_arrived',
  'ready_for_return_confirmation',
  'returned',
  'returned_finish',
]);

const deliveredStatuses = new Set(['delivered', 'delivered_finish']);
// Returns retain the existing fulfillment mapping; they are not COMPLETED.
const acceptedStatuses = new Set([
  ...assignedStatuses,
  ...pickedUpStatuses,
  ...deliveredStatuses,
]);
acceptedStatuses.delete('ready_for_approval');
const canceledStatuses = new Set([
  'cancelled',
  'cancelled_by_taxi',
  'cancelled_with_payment',
  'cancelled_with_items_on_hands',
]);

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private yandexSyncRunning = false;

  constructor(
    private readonly db: DbService,
    private readonly yandex: YandexService,
  ) {}

  config() {
    return { yandexEnabled: this.yandex.isAvailable() };
  }

  async quote(orderId: number) {
    const input = await this.yandexInput(orderId);
    const { offerPayload: _offerPayload, ...quote } =
      await this.yandex.calculate(input);

    if (quote.currency !== 'RUB') {
      throw new BadGatewayException('Яндекс вернул стоимость не в рублях');
    }

    await this.db.$transaction(async (db) => {
      await this.lockOrder(db, orderId);
      const order = await db.order.findUnique({
        where: { id: orderId },
        include: { delivery: true, deliveryAttempt: true },
      });
      if (
        !order ||
        order.status !== 'READY' ||
        order.type !== 'DELIVERY' ||
        order.deliveryAttempt ||
        order.delivery?.externalOrderId ||
        order.delivery?.provider === 'OTHER'
      ) {
        throw new ConflictException('Заказ или способ доставки уже изменился');
      }
      const totals = deliveryTotals(order, quote.price);
      await db.delivery.upsert({
        where: { orderId },
        create: {
          orderId,
          provider: 'YANDEX',
          price: quote.price,
          publicToken: randomBytes(32).toString('base64url'),
        },
        update: { price: quote.price },
      });
      await db.order.update({ where: { id: orderId }, data: totals });
    });
    return quote;
  }

  async order(orderId: number, waitForAssessment = true) {
    const reservation = await this.reserve(orderId);
    if ('result' in reservation) return reservation.result;
    let { attempt } = reservation;
    const token = attempt.leaseToken!;
    try {
      if (!attempt.requestBody) {
        const body = await this.yandex.prepare(await this.yandexInput(orderId));
        attempt = await this.checkpoint(orderId, token, { requestBody: body });
      }
      if (!attempt.externalOrderId) {
        await this.checkpoint(orderId, token, {});
        const claimId = await this.yandex.create(
          attempt.requestId,
          attempt.requestBody!,
        );
        // The first local claim ID write precedes assessment, accept and tracking.
        attempt = await this.checkpoint(orderId, token, {
          externalOrderId: claimId,
          state: 'CREATED',
        });
      }
      const claimId = attempt.externalOrderId!;
      let assessed: Awaited<ReturnType<YandexService['inspect']>> | undefined;
      for (let index = 0; index < (waitForAssessment ? 20 : 1); index++) {
        await this.checkpoint(orderId, token, {});
        assessed = await this.yandex.inspect(claimId);
        await this.checkpoint(orderId, token, {
          providerStatus: assessed.providerStatus,
        });
        if (!['new', 'estimating'].includes(assessed.providerStatus)) break;
        if (waitForAssessment) await delay(1_000);
      }
      if (
        !assessed ||
        ['new', 'estimating'].includes(assessed.providerStatus)
      ) {
        throw new BadGatewayException(
          'Яндекс ещё оценивает заявку. Повторите оформление.',
        );
      }
      if (assessed.providerStatus === 'ready_for_approval') {
        if (assessed.currency !== 'RUB' || assessed.price === null)
          throw new BadGatewayException(
            'Яндекс не вернул актуальную стоимость заявки в рублях',
          );
        positiveDeliveryPrice(assessed.price);
        await this.checkpoint(orderId, token, {});
        const status = await this.yandex.accept(claimId, assessed.version);
        await this.requireAccepted(orderId, token, status);
      } else {
        // An accept response may have been lost. Remote state, not a second accept,
        // tells us whether the already persisted claim is in progress.
        await this.requireAccepted(orderId, token, assessed.providerStatus);
      }
      attempt = await this.checkpoint(orderId, token, {
        state: 'ACCEPTED',
        acceptedAt: attempt.acceptedAt ?? new Date(),
      });
      const synced = await this.yandex.sync(claimId);
      if (synced.claimId !== claimId)
        throw new BadGatewayException('Яндекс вернул другую заявку');
      await this.requireAccepted(orderId, token, synced.providerStatus);
      const claim = {
        ...synced,
        price: synced.price ?? assessed.price,
        priceIsFinal:
          synced.price === null ? assessed.priceIsFinal : synced.priceIsFinal,
      };
      if (claim.currency !== 'RUB' || claim.price === null)
        throw new BadGatewayException(
          'Яндекс не вернул актуальную стоимость доставки в рублях',
        );
      positiveDeliveryPrice(claim.price);
      return await this.saveBooking(orderId, token, claim, claim.price);
    } catch (error) {
      // Keep the durable stage and replay identity even when DB/provider outcome
      // is unknown. A dead process leaves a lease which another worker can reclaim.
      await this.db.deliveryAttempt
        .updateMany({
          where: { orderId, leaseToken: token },
          data: {
            ...(error instanceof YandexRequestError && !error.retryable
              ? { state: 'NEEDS_REVIEW' as const }
              : {}),
            leaseToken: null,
            leaseUntil: null,
            lastError:
              'Оформление не завершено. Повторите проверку той же заявки; другая доставка заблокирована.',
          },
        })
        .catch(() => {});
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException(
        'Не удалось завершить оформление Яндекс. Попытка сохранена; повторите проверку.',
      );
    }
  }

  private async reserve(orderId: number) {
    return this.db.$transaction(async (db) => {
      await this.lockOrder(db, orderId);
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { payment: true, delivery: true, deliveryAttempt: true },
      });
      requirePaid(order);
      if (order.type !== 'DELIVERY' || order.delivery?.provider === 'OTHER')
        throw new ConflictException('Способ доставки уже изменился');
      const previous = order.deliveryAttempt;
      if (
        order.delivery?.externalOrderId &&
        (!previous || previous.state === 'ACTIVE')
      ) {
        return {
          result: {
            order: await db.order.findUniqueOrThrow({ where: { id: orderId } }),
            delivery: order.delivery,
          },
        };
      }
      if (order.status !== 'READY')
        throw new ConflictException(
          'Оформить доставку можно только для собранного заказа',
        );
      if (previous?.leaseUntil && previous.leaseUntil > new Date())
        throw new ConflictException(
          'Заявка Яндекс уже обрабатывается. Повторите проверку позже.',
        );
      if (previous && previous.provider !== 'YANDEX')
        throw new ConflictException(
          'Для заказа уже зарезервирован другой способ доставки',
        );
      const lease = {
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + BOOKING_LEASE_MS),
      };
      const attempt = previous
        ? await db.deliveryAttempt.update({ where: { orderId }, data: lease })
        : await db.deliveryAttempt.create({
            data: {
              orderId,
              provider: 'YANDEX',
              requestId: order.publicId,
              ...lease,
            },
          });
      return { attempt };
    });
  }

  private async checkpoint(
    orderId: number,
    token: string,
    data: Prisma.DeliveryAttemptUpdateManyMutationInput,
  ) {
    return this.db.$transaction(async (db) => {
      await this.lockOrder(db, orderId);
      const changed = await db.deliveryAttempt.updateMany({
        where: { orderId, leaseToken: token, leaseUntil: { gt: new Date() } },
        data: { ...data, leaseUntil: new Date(Date.now() + BOOKING_LEASE_MS) },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          'Проверка заявки уже продолжена другим запросом. Обновите заказ.',
        );
      return db.deliveryAttempt.findUniqueOrThrow({ where: { orderId } });
    });
  }

  private async requireAccepted(
    orderId: number,
    token: string,
    status: string,
  ) {
    if (acceptedStatuses.has(status)) {
      await this.checkpoint(orderId, token, { providerStatus: status });
      return;
    }
    await this.checkpoint(orderId, token, {
      state: 'NEEDS_REVIEW',
      providerStatus: status,
    });
    throw new ConflictException(
      'Состояние заявки Яндекс требует проверки. Новая доставка заблокирована; повторите проверку или обратитесь к администратору.',
    );
  }

  private async saveBooking(
    orderId: number,
    token: string,
    claim: YandexClaimInfo,
    price: number,
  ) {
    return this.db.$transaction(async (db) => {
      await this.lockOrder(db, orderId);
      const attempt = await db.deliveryAttempt.findUniqueOrThrow({
        where: { orderId },
      });
      if (
        attempt.leaseToken !== token ||
        !attempt.leaseUntil ||
        attempt.leaseUntil <= new Date()
      )
        throw new ConflictException(
          'Проверка заявки уже продолжена другим запросом',
        );
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { payment: true, delivery: true },
      });
      requirePaid(order);
      if (
        order.type !== 'DELIVERY' ||
        order.status !== 'READY' ||
        order.delivery?.provider === 'OTHER' ||
        (order.delivery?.externalOrderId &&
          order.delivery.externalOrderId !== claim.claimId)
      )
        throw new ConflictException('Способ доставки уже изменился');
      const status = this.nextStatus('ASSIGNED', claim.providerStatus);
      const data = {
        provider: 'YANDEX' as const,
        status,
        externalOrderId: claim.claimId,
        trackingUrl: claim.trackingUrl,
        courierName: claim.courierName,
        courierPhone: null,
        price,
        providerStatus: claim.providerStatus,
        providerUpdatedAt: this.providerDate(claim),
        syncedAt: new Date(),
      };
      const delivery = await db.delivery.upsert({
        where: { orderId },
        create: {
          orderId,
          ...data,
          publicToken: randomBytes(32).toString('base64url'),
        },
        update: data,
      });
      const updatedOrder = await db.order.update({
        where: { id: orderId },
        data: {
          status:
            status === 'DELIVERED'
              ? 'COMPLETED'
              : status === 'PICKED_UP'
                ? 'DELIVERING'
                : 'READY',
          ...deliveryTotals(order, price),
        },
      });
      await db.deliveryAttempt.update({
        where: { orderId },
        data: {
          state: 'ACTIVE',
          providerStatus: claim.providerStatus,
          completedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
        },
      });
      await message(db, orderId, status === 'DELIVERED' ? 'Заказ доставлен.' : 'Статус доставки обновлён.', 'SYSTEM', null, null, 'customer',
        status === 'DELIVERED' ? 'ORDER_COMPLETED' : 'DELIVERY_CHANGED');
      return { order: updatedOrder, delivery };
    });
  }

  async syncYandexDelivery(deliveryId: number) {
    const delivery = await this.db.delivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, provider: true, externalOrderId: true },
    });

    if (
      !delivery ||
      delivery.provider !== 'YANDEX' ||
      !delivery.externalOrderId
    ) {
      throw new NotFoundException('Яндекс Доставка не найдена');
    }

    const claim = await this.yandex.sync(delivery.externalOrderId);

    if (claim.price !== null && claim.currency !== 'RUB') {
      throw new BadGatewayException('Яндекс вернул стоимость не в рублях');
    }

    return this.applyYandexState(delivery.id, claim);
  }

  async syncActiveYandexDeliveries() {
    if (!this.yandex.isSyncAvailable() || this.yandexSyncRunning) return;

    this.yandexSyncRunning = true;

    try {
      const active = await this.db.delivery.findMany({
        where: {
          provider: 'YANDEX',
          externalOrderId: { not: null },
          OR: [
            { status: { in: ['PENDING', 'ASSIGNED', 'PICKED_UP'] } },
            // final_price can arrive after the terminal status, without a callback.
            {
              status: { in: ['DELIVERED', 'CANCELED'] },
              providerUpdatedAt: {
                gte: new Date(Date.now() - 24 * 60 * 60 * 1_000),
              },
            },
          ],
        },
        select: { id: true, externalOrderId: true },
      });

      for (let offset = 0; offset < active.length; offset += 1_000) {
        const batch = active.slice(offset, offset + 1_000);
        const deliveries = new Map(
          batch.flatMap((delivery) =>
            delivery.externalOrderId
              ? [[delivery.externalOrderId, delivery.id] as const]
              : [],
          ),
        );

        if (!deliveries.size) continue;

        const claims = await this.yandex.bulkInfo([...deliveries.keys()]);

        for (const claim of claims) {
          const deliveryId = deliveries.get(claim.claimId);
          if (!deliveryId) continue;

          if (claim.price !== null && claim.currency !== 'RUB') {
            this.logger.warn(
              `Яндекс вернул стоимость не в рублях для заявки ${claim.claimId}`,
            );
            continue;
          }

          try {
            await this.applyYandexState(deliveryId, claim);
          } catch (error) {
            this.logger.error(
              `Не удалось применить состояние заявки Яндекс ${claim.claimId}: ${this.errorMessage(error)}`,
            );
          }
        }
      }
      // Bounded recovery also finds attempts which have no local Delivery yet.
      // NEEDS_REVIEW is retried only by an explicit staff action.
      const pending = await this.db.deliveryAttempt.findMany({
        where: {
          state: { in: ['RESERVED', 'CREATED', 'ACCEPTED'] },
          updatedAt: { lte: new Date(Date.now() - 15_000) },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        select: { orderId: true },
        orderBy: { updatedAt: 'asc' },
        take: 2,
      });
      await Promise.all(
        pending.map(async (attempt) => {
          try {
            await this.order(attempt.orderId, false);
          } catch {
            this.logger.warn(
              `Не завершена попытка Яндекс для заказа ${attempt.orderId}; состояние сохранено`,
            );
          }
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Не удалось синхронизировать активные Яндекс Доставки: ${this.errorMessage(error)}`,
      );
    } finally {
      this.yandexSyncRunning = false;
    }
  }

  async syncOrder(orderId: number) {
    const attempt = await this.db.deliveryAttempt.findUnique({
      where: { orderId },
    });
    if (attempt && attempt.state !== 'ACTIVE') return this.order(orderId);
    const delivery = await this.db.delivery.findUnique({
      where: { orderId },
      select: { id: true },
    });

    if (!delivery) throw new NotFoundException('Яндекс Доставка не найдена');
    return this.syncYandexDelivery(delivery.id);
  }

  async syncClaim(claimId: string) {
    const delivery = await this.db.delivery.findFirst({
      where: { provider: 'YANDEX', externalOrderId: claimId },
      select: { id: true },
    });

    if (!delivery) {
      const attempt = await this.db.deliveryAttempt.findUnique({
        where: { externalOrderId: claimId },
      });
      if (!attempt) throw new NotFoundException('Яндекс Доставка не найдена');
      return this.order(attempt.orderId);
    }
    return this.syncYandexDelivery(delivery.id);
  }

  async get(publicToken: string) {
    const delivery = await this.db.delivery.findUnique({
      where: { publicToken },
      select: {
        provider: true,
        status: true,
        externalOrderId: true,
        trackingUrl: true,
        courierName: true,
        courierPhone: true,
        price: true,
        providerStatus: true,
        syncedAt: true,
        order: {
          select: {
            id: true,
            status: true,
            deliveryAt: true,
            subtotal: true,
            deliveryPrice: true,
            total: true,
            finalSubtotal: true,
            finalTotal: true,
          },
        },
      },
    });

    if (!delivery) throw new NotFoundException('Доставка не найдена');
    return delivery;
  }

  private async applyYandexState(deliveryId: number, claim: YandexClaimInfo) {
    return this.db.$transaction(async (db) => {
      const target = await db.delivery.findUnique({
        where: { id: deliveryId },
        select: { orderId: true },
      });
      if (!target) throw new NotFoundException('Яндекс Доставка не найдена');
      // Same lock order as assembly, booking and OTHER: Order before Delivery.
      await this.lockOrder(db, target.orderId);

      const current = await db.delivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          status: true,
          providerUpdatedAt: true,
          provider: true,
          externalOrderId: true,
          trackingUrl: true,
          courierName: true,
          price: true,
          order: {
            select: {
              id: true,
              status: true,
              subtotal: true,
              finalSubtotal: true,
              payment: { select: { status: true } },
            },
          },
        },
      });

      if (!current) throw new NotFoundException('Яндекс Доставка не найдена');
      if (
        current.provider !== 'YANDEX' ||
        current.externalOrderId !== claim.claimId
      ) {
        throw new ConflictException('Способ доставки уже изменился');
      }

      const providerUpdatedAt = this.providerDate(claim);
      if (
        current.providerUpdatedAt &&
        (!providerUpdatedAt || providerUpdatedAt < current.providerUpdatedAt)
      ) {
        return { delivery: current, order: current.order, stale: true };
      }

      const status = this.nextStatus(current.status, claim.providerStatus);
      if (claim.price !== null) positiveDeliveryPrice(claim.price);
      // Only a newer final_price may revise an accepted price. Offer-only and
      // equal-timestamp responses cannot roll the final price back.
      const newer =
        providerUpdatedAt !== null &&
        (!current.providerUpdatedAt ||
          providerUpdatedAt > current.providerUpdatedAt);
      const price =
        claim.price !== null &&
        (current.price === null ||
          current.price === 0 ||
          (claim.priceIsFinal && newer))
          ? claim.price
          : current.price;
      const totals = price === null ? {} : deliveryTotals(current.order, price);
      const delivery = await db.delivery.update({
        where: { id: deliveryId },
        data: {
          status,
          providerStatus: claim.providerStatus,
          providerUpdatedAt: providerUpdatedAt ?? current.providerUpdatedAt,
          syncedAt: new Date(),
          trackingUrl: claim.trackingUrl ?? current.trackingUrl,
          courierName: claim.courierName ?? current.courierName,
          price,
        },
      });

      let orderStatus = current.order.status;
      if (status === 'PICKED_UP' && orderStatus === 'READY') {
        orderStatus = 'DELIVERING';
      } else if (
        status === 'DELIVERED' &&
        (orderStatus === 'READY' || orderStatus === 'DELIVERING')
      ) {
        orderStatus = 'COMPLETED';
      } else if (
        status === 'CANCELED' &&
        orderStatus === 'READY' &&
        current.order.payment?.status !== 'PAID'
      ) {
        orderStatus = 'CANCELED';
        await db.orderPayment.updateMany({
          where: {
            orderId: current.order.id,
            status: { in: ['AWAITING', 'REPORTED'] },
          },
          data: { status: 'CANCELED' },
        });
      }

      const order = await db.order.update({
        where: { id: current.order.id },
        data: {
          status: orderStatus,
          ...totals,
        },
      });

      if (status !== current.status || price !== current.price || orderStatus !== current.order.status)
        await message(db, current.order.id, orderStatus === 'COMPLETED' ? 'Заказ доставлен.' :
          orderStatus === 'CANCELED' ? 'Заказ отменён.' : 'Статус доставки обновлён.', 'SYSTEM', null, null, 'customer',
          orderStatus === 'COMPLETED' && current.order.status !== 'COMPLETED' ? 'ORDER_COMPLETED' :
            orderStatus === 'CANCELED' && current.order.status !== 'CANCELED' ? 'ORDER_CANCELED' : 'DELIVERY_CHANGED');
      return { delivery, order, stale: false };
    });
  }

  private nextStatus(
    current: DeliveryStatus,
    providerStatus: string,
  ): DeliveryStatus {
    if (current === 'DELIVERED' || current === 'CANCELED') return current;
    if (deliveredStatuses.has(providerStatus)) return 'DELIVERED';

    if (canceledStatuses.has(providerStatus)) {
      return deliveryRank[current] < deliveryRank.PICKED_UP
        ? 'CANCELED'
        : current;
    }

    let next: Exclude<DeliveryStatus, 'CANCELED'> = 'PENDING';
    if (pickedUpStatuses.has(providerStatus)) next = 'PICKED_UP';
    else if (assignedStatuses.has(providerStatus)) next = 'ASSIGNED';

    return deliveryRank[next] > deliveryRank[current] ? next : current;
  }

  private providerDate(claim: YandexClaimInfo) {
    if (!claim.providerUpdatedAt) return null;
    const date = new Date(claim.providerUpdatedAt);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'неизвестная ошибка';
  }

  private async yandexInput(orderId: number): Promise<YandexOrderInput> {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: {
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
        delivery: { select: { externalOrderId: true, provider: true } },
        items: {
          select: {
            id: true,
            productName: true,
            unit: true,
            status: true,
            actualQty: true,
            actualTotal: true,
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Заказ не найден');
    if (order.type !== 'DELIVERY' || order.status !== 'READY') {
      throw new BadRequestException(
        'Яндекс Доставку можно рассчитать только для собранного заказа',
      );
    }
    if (
      order.delivery?.externalOrderId ||
      order.delivery?.provider === 'OTHER'
    ) {
      throw new ConflictException('Яндекс Доставка для заказа уже создана');
    }
    if (!order.city || !order.street || !order.house) {
      throw new BadRequestException('Для доставки не заполнен полный адрес');
    }

    const items = order.items
      .filter(
        (item) =>
          item.status === 'PICKED' &&
          item.actualQty !== null &&
          item.actualTotal !== null,
      )
      .map((item) => ({
        id: item.id,
        title: item.productName,
        unit: item.unit,
        actualQty: item.actualQty!,
        actualTotal: item.actualTotal!,
      }));

    if (!items.length) {
      throw new BadRequestException(
        'В заказе нет товаров для передачи курьеру',
      );
    }

    return {
      requestId: order.publicId,
      orderId: order.id,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      address: {
        fullname: [order.city, order.street, order.house].join(', '),
        city: order.city,
        street: order.street,
        building: order.house,
        porch: order.entrance ?? undefined,
        floor: order.floor ?? undefined,
        flat: order.flat ?? undefined,
        doorCode: order.intercom ?? undefined,
        comment: order.comment ?? undefined,
      },
      items,
    };
  }

  private async lockOrder(db: Prisma.TransactionClient, id: number) {
    const rows = await db.$queryRaw<{ id: number }[]>`
      SELECT "id"
      FROM "Order"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    if (!rows.length) throw new NotFoundException('Заказ не найден');
  }
}
