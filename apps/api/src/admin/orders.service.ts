import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { StaffService } from '../staff/staff.service.js';
import { addDays, localInstant } from './shop-hours.js';
import { financeLine, financeTotals } from './finance.math.js';
import type { OrdersQuery } from './orders.schema.js';

@Injectable()
export class AdminOrdersService {
  constructor(private readonly db: DbService, private readonly staff: StaffService) {}
  async list(query: OrdersQuery) {
    const { page, limit, search, number, phone, name, from, to, status, type, paymentStatus } = query;
    const where: Prisma.OrderWhereInput = {
      ...(number ? { id: number } : {}),
      ...(phone ? { customerPhone: { contains: phone } } : {}),
      ...(name ? { customerName: { contains: name, mode: 'insensitive' } } : {}),
      ...(status ? { status } : {}), ...(type ? { type } : {}),
      ...(paymentStatus ? { payment: { is: { status: paymentStatus } } } : {}),
      ...(from || to ? { createdAt: {
        ...(from ? { gte: localInstant(from, 0) } : {}),
        ...(to ? { lt: localInstant(addDays(to, 1), 0) } : {}),
      } } : {}),
      ...(search ? { OR: [
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search } },
        ...(Number.isSafeInteger(Number(search)) ? [{ id: Number(search) }] : []),
      ] } : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.order.findMany({ where, orderBy: { id: 'desc' },
        skip: (page - 1) * limit, take: limit,
        select: { id: true, publicId: true, createdAt: true, completedAt: true,
          customerName: true, customerPhone: true, type: true, deliveryAt: true,
          total: true, finalTotal: true, status: true,
          payment: { select: { status: true } }, userId: true },
      }),
      this.db.order.count({ where }),
    ]);
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }
  async get(id: number) {
    const order = await this.staff.get(id);
    const internal = await this.db.order.findUnique({ where: { id }, select: {
      completedAt: true, userId: true,
      user: { select: { id: true, name: true, phone: true } },
      items: { select: { id: true, productName: true, status: true, qty: true,
        actualQty: true, total: true, actualTotal: true, priceQty: true,
        settlementModeSnapshot: true, basePriceSnapshot: true }, orderBy: { id: 'asc' } },
      extras: { where: { status: 'ACTIVE' }, select: { amount: true } },
      messages: { orderBy: { id: 'asc' }, take: 100,
        select: { id: true, text: true, createdAt: true, sender: true } },
      staffAudits: { orderBy: { id: 'desc' }, take: 100 },
    } });
    if (!internal) throw new NotFoundException();
    const lines = internal.items.map(financeLine);
    return { ...order, completedAt: internal.completedAt, userId: internal.userId,
      purchaser: internal.user, messages: internal.messages, history: internal.staffAudits,
      finance: {
        lines, totals: financeTotals(lines,
          internal.extras.reduce((acc, extra) => acc + extra.amount, 0), order.deliveryPrice ?? 0),
      },
    };
  }
}
