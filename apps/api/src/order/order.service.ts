import {
  BadRequestException,
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

@Injectable()
export class OrderService {
  constructor(private readonly db: DbService) {}

  async create(
    userId: number | null,
    guestToken: string | undefined,
    data: OrderInput,
  ) {
    const qty = new Map<number, number>();

    for (const item of data.items) {
      qty.set(item.productId, (qty.get(item.productId) ?? 0) + item.qty);
    }

    const ids = [...qty.keys()];

    const products = await this.db.product.findMany({
      where: {
        id: {
          in: ids,
        },
        active: true,
      },

      select: {
        id: true,
        name: true,
        slug: true,
        price: true,
        priceQty: true,
        unit: true,
        min: true,
        step: true,

        images: {
          select: {
            url: true,
          },
          orderBy: {
            sort: 'asc',
          },
          take: 1,
        },
      },
    });

    if (products.length !== ids.length) {
      throw new BadRequestException('Некоторые товары недоступны');
    }

    const items = products.map((product) => {
      const itemQty = qty.get(product.id)!;

      if (
        itemQty < product.min ||
        (itemQty - product.min) % product.step !== 0
      ) {
        throw new BadRequestException(
          `Некорректное количество: ${product.name}`,
        );
      }

      const total = Math.round((product.price * itemQty) / product.priceQty);

      return {
        productId: product.id,
        productName: product.name,
        productSlug: product.slug,
        image: product.images[0]?.url,
        price: product.price,
        priceQty: product.priceQty,
        unit: product.unit,
        qty: itemQty,
        total,
      };
    });

    const subtotal = items.reduce((sum, item) => sum + item.total, 0);

    const deliveryPrice = 0;
    const total = subtotal + deliveryPrice;

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

  async get(publicId: string, userId: number | null, guestToken?: string) {
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

    const order = await this.db.order.findFirst({
      where,

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

        deliveryAt: true,

        subtotal: true,
        deliveryPrice: true,
        total: true,
        finalSubtotal: true,
        finalTotal: true,

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

    return order;
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
