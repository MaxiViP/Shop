import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { phone } from '../common/phone.js';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import {
  createGuestToken,
  GUEST_TTL,
  guestTokenHash,
} from '../common/guest.js';
import type { OrderInput } from './schema.js';
import { totalWithDelivery } from './pricing.js';
import { SERVICE_MARKUP_PERCENT } from '../product/pricing.js';
import { paymentSelect, paymentDetails } from './payment.js';
import type { PaymentMethod, Prisma } from '../db/gen/client.js';
import { issueSummary, message } from './coordination.js';
import { checkoutLimits } from './limits.js';
import { assertMarketTime } from '../admin/shop-hours.js';
import { QueueService } from './queue.js';
import { inAppEvent, telegramEvent } from './outbox.js';
import {
  cartProductSelect,
  cartQuantities,
  cartQuote,
  type QuoteInput,
} from './cart-quote.js';

export const orderCreatedSelect = {
  id: true,
  publicId: true,
  type: true,
  status: true,
  fulfillmentMode: true,
  scheduledFor: true,
  subtotal: true,
  deliveryPrice: true,
  total: true,
  createdAt: true,
  items: { select: { id: true, productName: true, qty: true, total: true } },
} satisfies Prisma.OrderSelect;

@Injectable()
export class OrderService {
  private readonly queue: QueueService;
  constructor(
    private readonly db: DbService,
    private readonly telegram: TelegramService,
  ) { this.queue = new QueueService(db); }

  async quote(data: QuoteInput, db: Prisma.TransactionClient = this.db) {
    const quantities = cartQuantities(data.items);
    const products = await db.product.findMany({
      where: { id: { in: [...quantities.keys()] }, active: true },
      select: cartProductSelect,
    });
    return cartQuote(quantities, products);
  }

  async create(
    userId: number | null,
    guestToken: string | undefined,
    data: OrderInput,
  ) {
    const result = await this.db.$transaction((db) => this.save(db, userId, guestToken, data));
    if (result.created) this.created(result.order.id);
    return result;
  }

  // The caller owns the transaction and MUST call created() only after commit.
  createIn(db: Prisma.TransactionClient, userId: number, data: OrderInput) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new BadRequestException();
    return this.save(db, userId, undefined, data);
  }

  created(orderId: number) { void this.telegram.notifyNewOrder(orderId); }

  async checkoutSession(guestToken?: string) {
    return this.db.$transaction(db => this.ensureGuest(guestToken, db));
  }

  offer() { return this.queue.publicView(undefined, this.db, new Date(), true); }

  async queueFor(publicId: string, userId: number | null, guestToken?: string) {
    const where = await this.access(publicId, userId, guestToken);
    const order = await this.db.order.findFirst({ where,
      select: { id: true, status: true, fulfillmentMode: true } });
    if (!order) throw new NotFoundException('Заказ не найден');
    return ['NEW', 'CONFIRMED'].includes(order.status) ?
      this.queue.publicView(order.id, this.db, new Date(), true, order.fulfillmentMode === 'SCHEDULED') : null;
  }

  async schedule(publicId: string, userId: number | null, guestToken: string | undefined,
    mode: 'ASAP' | 'SCHEDULED', requested?: string) {
    const access = await this.access(publicId, userId, guestToken);
    const now = new Date();
    return this.db.$transaction(async db => {
      // Same settings mutex as checkout: two callers cannot reserve the last slot.
      await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
      const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
      await db.$queryRaw`SELECT id FROM "Order" WHERE "publicId" = ${publicId}::uuid FOR UPDATE`;
      const order = await db.order.findFirst({ where: access,
        select: { id: true, status: true, fulfillmentMode: true, scheduledFor: true,
          assemblyStartedAt: true, payment: { select: { status: true } } } });
      if (!order) throw new NotFoundException('Заказ не найден');
      const at = requested ? new Date(requested) : null;
      if (order.fulfillmentMode === mode && order.scheduledFor?.getTime() === (at?.getTime() ?? undefined))
        return { fulfillmentMode: order.fulfillmentMode, scheduledFor: order.scheduledFor };
      if (!['NEW', 'CONFIRMED'].includes(order.status) || order.assemblyStartedAt ||
        ['PAID', 'REPORTED'].includes(order.payment?.status ?? ''))
        throw new ConflictException('Время подготовки уже нельзя изменить');
      if (mode === 'SCHEDULED') await this.queue.reserve(db, at!, settings, now, order.id,
        order.fulfillmentMode === 'SCHEDULED');
      const saved = await db.order.update({ where: { id: order.id }, data: {
        fulfillmentMode: mode, scheduledFor: mode === 'SCHEDULED' ? at : null,
      }, select: { fulfillmentMode: true, scheduledFor: true } });
      const staff = await db.user.findMany({ where: { role: { in: ['SELLER', 'ADMIN'] },
        ...(userId ? { id: { not: userId } } : {}) }, select: { id: true } });
      const eventId = randomUUID();
      for (const recipient of staff) await inAppEvent(db, { orderId: order.id, type: 'SCHEDULE_CHANGED',
        dedupeKey: `schedule:${order.id}:${eventId}:${recipient.id}`,
        eventData: { fulfillmentMode: mode, scheduledFor: saved.scheduledFor?.toISOString() ?? null } }, recipient.id);
      return saved;
    });
  }

  private async save(db: Prisma.TransactionClient, userId: number | null,
    guestToken: string | undefined, data: OrderInput) {
    if (data.checkoutRequestId) {
      await db.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${data.checkoutRequestId}))`;
      const previous = await db.order.findUnique({ where: { checkoutRequestId: data.checkoutRequestId },
        select: { ...orderCreatedSelect, userId: true, guestSessionId: true } });
      if (previous) {
        const guestId = userId ? null : await this.findGuest(guestToken, db);
        if ((userId && previous.userId === userId) || (guestId && previous.guestSessionId === guestId)) {
          const { userId: _userId, guestSessionId: _guestSessionId, ...order } = previous;
          return { order, guestToken: undefined, created: false };
        }
        throw new ConflictException('Повторное оформление недоступно в этой сессии');
      }
    }
    const productIds = [...new Set(data.items.map(item => item.productId))].sort((a, b) => a - b);
    for (const id of productIds)
      await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${id} FOR SHARE`;
    const quote = await this.quote(data, db);
    const settlement = await db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, settlementMode: true, basePrice: true },
    });
    const settlementById = new Map(settlement.map(product => [product.id, product]));
    if (data.quoteToken && data.quoteToken !== quote.token)
      throw new ConflictException({
        code: 'CART_CHANGED',
        message: 'Корзина изменилась. Проверьте актуальные товары и сумму.',
      });
    if (!quote.valid)
      throw new BadRequestException(
        'Проверьте доступность, количество и стоимость товаров в корзине',
      );
    const items = quote.items.map((item) => {
      const product = item.product!;
      const financialSnapshot = settlementById.get(product.id);
      if (!financialSnapshot)
        throw new ConflictException('Данные товара изменились. Повторите оформление заказа.');
      return {
        productId: product.id,
        settlementModeSnapshot: financialSnapshot.settlementMode,
        basePriceSnapshot: financialSnapshot.basePrice,
        productName: product.name,
        productSlug: product.slug,
        image: product.images[0]?.url,
        price: product.price,
        serviceMarkupPercentSnapshot: SERVICE_MARKUP_PERCENT,
        priceQty: product.priceQty,
        unit: product.unit,
        qty: item.qty,
        total: item.lineTotal!,
      };
    });

    const now = new Date();
    const subtotal = quote.subtotal!;
    // Serializes slot reservations, settings changes and concurrent checkout offers.
    await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
    await assertMarketTime(db, now, data.deliveryAt ? new Date(data.deliveryAt) : undefined);
    const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
    const load = await this.queue.snapshot(db, now);
    const mode = data.fulfillmentMode ?? 'ASAP';
    const scheduledFor = mode === 'SCHEDULED' ? new Date(data.scheduledFor!) : null;
    if (scheduledFor) await this.queue.reserve(db, scheduledFor, settings, now);
    checkoutLimits(data.type, subtotal, settings);

    const deliveryPrice = data.type === 'PICKUP' ? 0 : null;
    const total = totalWithDelivery(subtotal, deliveryPrice);

    const address = data.type === 'DELIVERY' ? data.address : undefined;

    let guestSessionId: string | null = null;
    let newGuestToken: string | undefined;

    if (!userId) {
      const guest = await this.ensureGuest(guestToken, db);

      guestSessionId = guest.id;
      newGuestToken = guest.token;
    }

    const order = await db.order.create({
      data: {
        weightToleranceBps: settings.weightToleranceBps,
        type: data.type,
        fulfillmentMode: mode,
        scheduledFor,
        checkoutRequestId: data.checkoutRequestId,

        customerName: data.customerName.trim(),

        customerPhone: phone(data.customerPhone),

        city: address?.city,
        street: address?.street,
        house: address?.house,
        buildingPart: address?.buildingPart || null,
        flat: address?.flat,
        entrance: address?.entrance,
        floor: address?.floor,
        intercom: address?.intercom,
        comment: address?.comment,

        deliveryAt: data.deliveryAt ? new Date(data.deliveryAt) : null,

        subtotal,
        deliveryPrice,
        total,

        userId,
        guestSessionId,

        items: {
          create: items,
        },
      },

      select: orderCreatedSelect,
    });

    if (load.showScheduledOffer && mode === 'ASAP')
      await telegramEvent(db, { orderId: order.id, type: 'QUEUE_DELAY', dedupeKey: `queue-delay:${order.id}` });

    return {
      order,
      guestToken: newGuestToken,
      created: true,
    };
  }

  async list(userId: number | null, guestToken?: string) {
    if (userId) {
      return this.db.order.findMany({
        where: {
          userId,
        },

        select: {
          id: true,
          publicId: true,
          type: true,
          status: true,
          fulfillmentMode: true,
          scheduledFor: true,
          total: true,
          finalTotal: true,
          subtotal: true,
          finalSubtotal: true,
          payment: { select: paymentSelect },
          issues: issueSummary,
          customerUnread: true,
          deliveryAt: true,
          createdAt: true,

          items: {
            select: {
              id: true,
              productName: true,
              qty: true,
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });
    }

    const guestSessionId = await this.findGuest(guestToken);

    if (!guestSessionId) {
      return [];
    }

    return this.db.order.findMany({
      where: {
        guestSessionId,
      },

      select: {
        id: true,
        publicId: true,
        type: true,
        status: true,
        fulfillmentMode: true,
        scheduledFor: true,
        total: true,
        finalTotal: true,
        subtotal: true,
        finalSubtotal: true,
        payment: { select: paymentSelect },
        issues: issueSummary,
        customerUnread: true,
        deliveryAt: true,
        createdAt: true,

        items: {
          select: {
            id: true,
            productName: true,
            qty: true,
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async access(publicId: string, userId: number | null, guestToken?: string) {
    let where:
      | {
          publicId: string;
          userId: number;
        }
      | {
          publicId: string;
          guestSessionId: string;
        };

    if (userId) {
      where = {
        publicId,
        userId,
      };
    } else {
      const guestSessionId = await this.findGuest(guestToken);

      if (!guestSessionId) {
        throw new NotFoundException('Заказ не найден');
      }

      where = {
        publicId,
        guestSessionId,
      };
    }

    return where;
  }

  async unread(userId: number | null, guestToken?: string) {
    const guestSessionId = userId ? null : await this.findGuest(guestToken);
    if (!userId && !guestSessionId) return { count: 0, latestOrderId: null };
    const where = userId ? { userId } : { guestSessionId: guestSessionId! };
    const total = await this.db.order.aggregate({ where, _sum: { customerUnread: true } });
    const latest = await this.db.orderChatMessage.findFirst({
      where: { recipient: { in: ['customer', 'both'] }, order: { ...where, customerUnread: { gt: 0 } } },
      orderBy: { id: 'desc' }, select: { createdAt: true, order: { select: { publicId: true } } },
    });
    const revision = await this.db.orderChatImageRevision.findFirst({
      where: { version: { gt: 0 }, actorType: { in: ['SELLER', 'ADMIN'] },
        message: { order: { ...where, customerUnread: { gt: 0 } } } },
      orderBy: { id: 'desc' },
      select: { createdAt: true, message: { select: { order: { select: { publicId: true } } } } },
    });
    return { count: total._sum.customerUnread ?? 0,
      latestOrderId: revision && (!latest || revision.createdAt >= latest.createdAt)
        ? revision.message.order.publicId : latest?.order.publicId ?? null };
  }

  async get(publicId: string, userId: number | null, guestToken?: string) {
    const where = await this.access(publicId, userId, guestToken);

    const order = await this.db.order.findFirst({
      where,

      select: {
        extras: { where: { status: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true, title: true, comment: true, quantity: true, unitPrice: true, amount: true } },
        issues: { orderBy: { id: 'asc' }, select: {
          orderItemId: true, replacementItemId: true, type: true, status: true, resolution: true,
          actualQty: true, approvedActualQty: true,
          proposedName: true, proposedQty: true, proposedUnit: true,
          proposedPrice: true, proposedPriceQty: true,
        } },
        id: true,
        publicId: true,
        type: true,
        status: true,
        fulfillmentMode: true,
        scheduledFor: true,
        assemblyStartedAt: true,

        customerName: true,
        customerPhone: true,

        city: true,
        street: true,
        house: true, buildingPart: true,
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
        assemblyFinalizedAt: true,
        weightToleranceBps: true,
        customerUnread: true,
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
            providerStatus: true,
            syncedAt: true,
          },
        },

        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            productName: true,
            productSlug: true,
            image: true,

            price: true,
            actualPrice: true,
            priceQty: true,
            unit: true,

            qty: true,
            actualQty: true,

            total: true,
            actualTotal: true,

            status: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }

    return {
      ...order,
      queue: order.status === 'NEW' || order.status === 'CONFIRMED'
        ? await this.queue.publicView(order.id) : null,
      extras: order.extras,
      paymentDetails:
        order.assemblyFinalizedAt && order.status !== 'CANCELED'
          ? paymentDetails()
          : null,
    };
  }

  async reportPayment(
    publicId: string,
    userId: number | null,
    guestToken: string | undefined,
    method: PaymentMethod,
  ) {
    // Resolve/expire guest access before acquiring the Order lock.
    const access = await this.access(publicId, userId, guestToken);
    let changedId: number | undefined;
    const result = await this.db.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "Order" WHERE "publicId" = ${publicId}::uuid FOR UPDATE`;
      // Use the existing owner/guest authorization, while the order is locked.
      const order = await db.order.findFirst({
        where: access, select: {id:true, status:true, assemblyFinalizedAt:true,
          finalSubtotal:true, payment:{select:paymentSelect}},
      });
      if (!order) throw new NotFoundException('Заказ не найден');
      if (
        order.status === 'CANCELED' ||
        !order.assemblyFinalizedAt ||
        !order.payment ||
        order.payment.status === 'CANCELED' ||
        order.payment.amount !== order.finalSubtotal
      )
        throw new ConflictException('Оплата заказа сейчас недоступна');
      if (
        order.payment.status === 'REPORTED' ||
        order.payment.status === 'PAID'
      )
        return order.payment;
      if (order.status !== 'READY')
        throw new ConflictException('Оплата заказа сейчас недоступна');
      if (!paymentDetails().methods.includes(method))
        throw new BadRequestException('Способ оплаты не настроен');
      const payment = await db.orderPayment.update({
        where: { orderId: order.id },
        data: { status: 'REPORTED', method, reportedAt: new Date() },
        select: paymentSelect,
      });
      const methods = { SBP: 'СБП', CARD_TRANSFER: 'перевод на карту', QR: 'QR' };
      await message(db, order.id, 'Покупатель сообщил об оплате через ' + methods[method] +
        '. Проверьте поступление денег.', 'SYSTEM', userId, null, 'staff');
      changedId = order.id;
      return payment;
    });
    // Only the first committed report signals staff; never retry on display failure.
    if (changedId !== undefined) void this.telegram.notifyPaymentReported(changedId);
    return result;
  }

  async customerOrders(userId: number | null, guestToken?: string): Promise<Prisma.OrderWhereInput | null> {
    if (userId) return { userId };
    const guestSessionId = await this.findGuest(guestToken);
    return guestSessionId ? { guestSessionId } : null;
  }

  private async findGuest(token?: string, db: Prisma.TransactionClient = this.db) {
    if (!token) return null;

    const guest = await db.guestSession.findUnique({
      where: {
        tokenHash: guestTokenHash(token),
      },
    });

    if (!guest) return null;

    if (guest.expiresAt.getTime() < Date.now()) {
      await db.guestSession.delete({
        where: {
          id: guest.id,
        },
      });

      return null;
    }

    return guest.id;
  }

  private async ensureGuest(token?: string, db: Prisma.TransactionClient = this.db) {
    const id = await this.findGuest(token, db);

    if (id) {
      return {
        id,
        token: undefined,
      };
    }

    const newToken = createGuestToken();

    const guest = await db.guestSession.create({
      data: {
        tokenHash: guestTokenHash(newToken),

        expiresAt: new Date(Date.now() + GUEST_TTL),
      },
    });

    return {
      id: guest.id,
      token: newToken,
    };
  }
}
