import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { phone } from '../common/phone.js';
import { DbService } from '../db/db.service.js';
import {
  createGuestToken,
  GUEST_TTL,
  guestTokenHash,
} from '../common/guest.js';
import type { OrderInput } from './schema.js';
import { totalWithDelivery } from './pricing.js';
import { paymentSelect, paymentDetails } from './payment.js';
import type { PaymentMethod } from '../db/gen/client.js';
import { issueSummary } from './coordination.js';
import { checkoutLimits } from './limits.js';
import {
  cartProductSelect,
  cartQuantities,
  cartQuote,
  type QuoteInput,
} from './cart-quote.js';

@Injectable()
export class OrderService {
  constructor(private readonly db: DbService) {}

  async quote(data: QuoteInput) {
    const quantities = cartQuantities(data.items);
    const products = await this.db.product.findMany({
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
    const quote = await this.quote(data);
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
      return {
        productId: product.id,
        productName: product.name,
        productSlug: product.slug,
        image: product.images[0]?.url,
        price: product.price,
        priceQty: product.priceQty,
        unit: product.unit,
        qty: item.qty,
        total: item.lineTotal!,
      };
    });

    const subtotal = quote.subtotal!;
    const settings = await this.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
    checkoutLimits(data.type, subtotal, settings);

    const deliveryPrice = data.type === 'PICKUP' ? 0 : null;
    const total = totalWithDelivery(subtotal, deliveryPrice);

    const address = data.type === 'DELIVERY' ? data.address : undefined;

    let guestSessionId: string | null = null;
    let newGuestToken: string | undefined;

    if (!userId) {
      const guest = await this.ensureGuest(guestToken);

      guestSessionId = guest.id;
      newGuestToken = guest.token;
    }

    const order = await this.db.order.create({
      data: {
        weightToleranceBps: settings.weightToleranceBps,
        type: data.type,

        customerName: data.customerName.trim(),

        customerPhone: phone(data.customerPhone),

        city: address?.city,
        street: address?.street,
        house: address?.house,
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

      select: {
        id: true,
        publicId: true,
        type: true,
        status: true,
        subtotal: true,
        deliveryPrice: true,
        total: true,
        createdAt: true,

        items: {
          select: {
            id: true,
            productName: true,
            qty: true,
            total: true,
          },
        },
      },
    });

    return {
      order,
      guestToken: newGuestToken,
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
      orderBy: { id: 'desc' }, select: { order: { select: { publicId: true } } },
    });
    return { count: total._sum.customerUnread ?? 0, latestOrderId: latest?.order.publicId ?? null };
  }

  async get(publicId: string, userId: number | null, guestToken?: string) {
    const where = await this.access(publicId, userId, guestToken);

    const order = await this.db.order.findFirst({
      where,

      select: {
        extras: { where: { status: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true, title: true, comment: true, quantity: true, unitPrice: true, amount: true } },
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
        assemblyFinalizedAt: true,
        weightToleranceBps: true,
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
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }

    return {
      ...order,
      extras: order.assemblyFinalizedAt ? order.extras : [],
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
    return this.db.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "Order" WHERE "publicId" = ${publicId}::uuid FOR UPDATE`;
      // Use the existing owner/guest authorization, while the order is locked.
      const order = await this.get(publicId, userId, guestToken);
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
      return db.orderPayment.update({
        where: { orderId: order.id },
        data: { status: 'REPORTED', method, reportedAt: new Date() },
        select: paymentSelect,
      });
    });
  }

  private async findGuest(token?: string) {
    if (!token) return null;

    const guest = await this.db.guestSession.findUnique({
      where: {
        tokenHash: guestTokenHash(token),
      },
    });

    if (!guest) return null;

    if (guest.expiresAt.getTime() < Date.now()) {
      await this.db.guestSession.delete({
        where: {
          id: guest.id,
        },
      });

      return null;
    }

    return guest.id;
  }

  private async ensureGuest(token?: string) {
    const id = await this.findGuest(token);

    if (id) {
      return {
        id,
        token: undefined,
      };
    }

    const newToken = createGuestToken();

    const guest = await this.db.guestSession.create({
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
