import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { ItemInput, StatusInput } from './schema.js';

type Status = StatusInput['status'];

const transitions: Record<Status, Status[]> = {
  NEW: ['CONFIRMED', 'CANCELED'],

  CONFIRMED: ['ASSEMBLING', 'CANCELED'],

  ASSEMBLING: ['READY', 'CANCELED'],

  READY: ['DELIVERING', 'COMPLETED', 'CANCELED'],

  DELIVERING: ['COMPLETED'],

  COMPLETED: [],
  CANCELED: [],
};

@Injectable()
export class AdminService {
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

        total: true,
        finalTotal: true,
        createdAt: true,

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
      const item = await db.orderItem.findFirst({
        where: {
          id: itemId,
          orderId,
        },

        select: {
          id: true,
          price: true,
          priceQty: true,

          order: {
            select: {
              status: true,
            },
          },
        },
      });

      if (!item) {
        throw new NotFoundException('Позиция не найдена');
      }

      if (item.order.status !== 'ASSEMBLING') {
        throw new BadRequestException('Заказ сейчас не собирается');
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

  async status(id: number, next: Status) {
    return this.db.$transaction(async (db) => {
      const order = await db.order.findUnique({
        where: { id },

        select: {
          id: true,
          status: true,
          deliveryPrice: true,
        },
      });

      if (!order) {
        throw new NotFoundException('Заказ не найден');
      }

      if (!transitions[order.status].includes(next)) {
        throw new BadRequestException('Недопустимый переход статуса');
      }

      if (next === 'READY') {
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
      }

      return db.order.update({
        where: { id },

        data: {
          status: next,
        },
      });
    });
  }
}
