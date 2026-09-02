import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { OrderStatus, OrderType, Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import type { DeliveryInput, ItemInput } from './schema.js';

const cancelable: OrderStatus[] = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'];

@Injectable()
export class StaffService {
  constructor(private readonly db: DbService) {}

  list() {
    return this.db.order.findMany({
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

        deliveryAt: true,

        total: true,
        finalTotal: true,
        createdAt: true,

        delivery: {
          select: {
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
  }

  async get(id: number) {
    const order = await this.db.order.findUnique({
      where: { id },

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

    return order;
  }

  async item(orderId: number, itemId: number, data: ItemInput) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, orderId);

      if (order.status !== 'ASSEMBLING') {
        throw new BadRequestException('Заказ сейчас не собирается');
      }

      const item = await db.orderItem.findFirst({
        where: {
          id: itemId,
          orderId,
        },

        select: {
          id: true,
          price: true,
          priceQty: true,
          status: true,
        },
      });

      if (!item) {
        throw new NotFoundException('Позиция не найдена');
      }

      if (data.status === 'PENDING') {
        if (item.status !== 'PICKED' && item.status !== 'MISSING') {
          throw new BadRequestException('Позиция уже находится в сборке');
        }

        return db.orderItem.update({
          where: {
            id: item.id,
          },

          data: {
            status: 'PENDING',
            actualQty: null,
            actualTotal: null,
          },
        });
      }

      if (item.status !== 'PENDING') {
        throw new BadRequestException('Сначала верните позицию в сборку');
      }

      if (data.status === 'MISSING') {
        return db.orderItem.update({
          where: {
            id: item.id,
          },

          data: {
            status: 'MISSING',
            actualQty: 0,
            actualTotal: 0,
          },
        });
      }

      const actualTotal = Math.round(
        (item.price * data.actualQty) / item.priceQty,
      );

      return db.orderItem.update({
        where: {
          id: item.id,
        },

        data: {
          status: 'PICKED',
          actualQty: data.actualQty,
          actualTotal,
        },
      });
    });
  }

  confirm(id: number) {
    return this.transition(id, 'NEW', 'CONFIRMED');
  }

  startAssembly(id: number) {
    return this.transition(id, 'CONFIRMED', 'ASSEMBLING');
  }

  async finishAssembly(id: number) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

      if (order.status !== 'ASSEMBLING') {
        throw new BadRequestException('Заказ сейчас не собирается');
      }

      const pending = await db.orderItem.count({
        where: {
          orderId: id,
          status: 'PENDING',
        },
      });

      if (pending) {
        throw new BadRequestException('Сначала обработайте все товары');
      }

      const result = await db.orderItem.aggregate({
        where: {
          orderId: id,
        },

        _sum: {
          actualTotal: true,
        },
      });

      const finalSubtotal = result._sum.actualTotal ?? 0;

      return db.order.update({
        where: { id },

        data: {
          status: 'READY',
          finalSubtotal,
          finalTotal: finalSubtotal + order.deliveryPrice,
        },
      });
    });
  }

  completePickup(id: number) {
    return this.transition(id, 'READY', 'COMPLETED', 'PICKUP');
  }

  async cancel(id: number) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

      if (!cancelable.includes(order.status)) {
        throw new BadRequestException('Заказ нельзя отменить');
      }

      if (
        order.delivery &&
        order.delivery.status !== 'PENDING' &&
        order.delivery.status !== 'ASSIGNED' &&
        order.delivery.status !== 'CANCELED'
      ) {
        throw new BadRequestException('Заказ уже передан курьеру');
      }

      if (order.delivery?.provider === 'YANDEX' && order.delivery.externalOrderId) {
        throw new BadRequestException(
          'Созданную Яндекс Доставку нужно отменять через Яндекс',
        );
      }

      if (order.delivery) {
        await db.delivery.update({
          where: {
            id: order.delivery.id,
          },

          data: {
            status: 'CANCELED',
          },
        });
      }

      return db.order.update({
        where: { id },

        data: {
          status: 'CANCELED',
        },
      });
    });
  }

  async delivery(id: number, data: DeliveryInput) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

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
          price: data.price ?? null,
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

      const price = data.price ?? 0;
      const finalSubtotal = order.finalSubtotal ?? order.subtotal;

      await db.order.update({
        where: { id },
        data: {
          deliveryPrice: price,
          finalTotal: finalSubtotal + price,
        },
      });

      return delivery;
    });
  }

  async handoff(id: number) {
    return this.db.$transaction(async (db) => {
      const order = await this.lockedOrder(db, id);

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

      if (order.status !== current || (type && order.type !== type)) {
        throw new BadRequestException('Недопустимое действие с заказом');
      }

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

        delivery: {
          select: {
            id: true,
            provider: true,
            status: true,
            trackingUrl: true,
            courierName: true,
            courierPhone: true,
            externalOrderId: true,
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
