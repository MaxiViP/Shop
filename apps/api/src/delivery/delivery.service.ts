import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { DeliveryStatus, Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { deliveryTotals, positiveDeliveryPrice } from '../order/pricing.js';
import { requirePaid, paymentSelect } from '../order/payment.js';
import {
  type YandexClaimInfo,
  type YandexOrderInput,
  YandexService,
} from './yandex.service.js';

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
        include: { delivery: true },
      });
      if (
        !order ||
        order.status !== 'READY' ||
        order.type !== 'DELIVERY' ||
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

  async order(orderId: number) {
    // Payment is immutable after PAID; prohibit external side effects before it.
    const paidOrder = await this.db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        assemblyFinalizedAt: true,
        finalSubtotal: true,
        payment: { select: paymentSelect },
      },
    });
    requirePaid(paidOrder);
    const input = await this.yandexInput(orderId);
    const booking = await this.yandex.book(input);
    const price = booking.claim.price;

    if (booking.claim.currency !== 'RUB' || price === null) {
      throw new BadRequestException(
        'Яндекс не вернул актуальную стоимость доставки в рублях',
      );
    }

    positiveDeliveryPrice(price);
    return this.db.$transaction(async (db) => {
      await this.lockOrder(db, orderId);
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: {
          type: true,
          status: true,
          subtotal: true,
          finalSubtotal: true,
          assemblyFinalizedAt: true,
          payment: { select: paymentSelect },
          delivery: { select: { externalOrderId: true, provider: true } },
        },
      });

      if (
        order?.delivery?.provider === 'YANDEX' &&
        order.delivery.externalOrderId === booking.claim.claimId
      ) {
        // A concurrent booking already saved this idempotent claim. Keep its
        // newer status and price; polling will reconcile subsequent changes.
        return {
          order: await db.order.findUniqueOrThrow({ where: { id: orderId } }),
          delivery: await db.delivery.findUniqueOrThrow({ where: { orderId } }),
          quote: booking.quote,
        };
      }
      if (!order || order.type !== 'DELIVERY' || order.status !== 'READY') {
        throw new BadRequestException(
          'Яндекс Доставку можно заказать только для собранного заказа',
        );
      }
      requirePaid(order);

      if (
        order.delivery?.externalOrderId ||
        order.delivery?.provider === 'OTHER'
      ) {
        throw new ConflictException('Для заказа уже создана внешняя доставка');
      }

      const deliveryStatus = this.nextStatus(
        'ASSIGNED',
        booking.claim.providerStatus,
      );
      const orderStatus =
        deliveryStatus === 'DELIVERED'
          ? 'COMPLETED'
          : deliveryStatus === 'PICKED_UP'
            ? 'DELIVERING'
            : deliveryStatus === 'CANCELED'
              ? 'READY'
              : 'READY';
      const delivery = await db.delivery.upsert({
        where: { orderId },
        update: {
          provider: 'YANDEX',
          status: deliveryStatus,
          externalOrderId: booking.claim.claimId,
          trackingUrl: booking.claim.trackingUrl,
          courierName: booking.claim.courierName,
          courierPhone: null,
          price,
          providerStatus: booking.claim.providerStatus,
          providerUpdatedAt: this.providerDate(booking.claim),
          syncedAt: new Date(),
        },
        create: {
          orderId,
          provider: 'YANDEX',
          status: deliveryStatus,
          externalOrderId: booking.claim.claimId,
          trackingUrl: booking.claim.trackingUrl,
          courierName: booking.claim.courierName,
          price,
          providerStatus: booking.claim.providerStatus,
          providerUpdatedAt: this.providerDate(booking.claim),
          syncedAt: new Date(),
          publicToken: randomBytes(32).toString('base64url'),
        },
      });
      const updatedOrder = await db.order.update({
        where: { id: orderId },
        data: {
          status: orderStatus,
          ...deliveryTotals(order, price),
        },
      });

      return { order: updatedOrder, delivery, quote: booking.quote };
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
    } catch (error) {
      this.logger.warn(
        `Не удалось синхронизировать активные Яндекс Доставки: ${this.errorMessage(error)}`,
      );
    } finally {
      this.yandexSyncRunning = false;
    }
  }

  async syncOrder(orderId: number) {
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

    if (!delivery) throw new NotFoundException('Яндекс Доставка не найдена');
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
