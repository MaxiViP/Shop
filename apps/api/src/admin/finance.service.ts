import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { addDays, localInstant, moscowDay } from './shop-hours.js';
import { financeLine, financeTotals, splitMarkup } from './finance.math.js';
import type { FinanceQuery } from './finance.schema.js';

const orderSelect = {
  id: true, publicId: true, completedAt: true, customerName: true,
  finalTotal: true, deliveryPrice: true,
  items: { select: {
    id: true, productName: true, status: true, qty: true, actualQty: true,
    total: true, actualTotal: true, price: true, actualPrice: true, priceQty: true,
    settlementModeSnapshot: true, basePriceSnapshot: true,
  } },
  extras: { where: { status: 'ACTIVE' }, select: { amount: true } },
} satisfies Prisma.OrderSelect;
function sum(rows: number[]) {
  const total = rows.reduce((acc, value) => acc + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError('Financial total exceeds the safe integer range');
  return Number(total);
}
function periodBounds(query: FinanceQuery, today: string) {
  const firstOfMonth = today.slice(0, 7) + '-01';
  let from = today;
  let to = today;
  if (query.period === 'yesterday') from = to = addDays(today, -1);
  if (query.period === 'week') from = addDays(today, -6);
  if (query.period === 'month') from = firstOfMonth;
  if (query.period === 'previousMonth') {
    to = addDays(firstOfMonth, -1);
    from = to.slice(0, 7) + '-01';
  }
  if (query.period === 'custom') {
    if (!query.from || !query.to) throw new BadRequestException('Укажите начало и конец периода');
    from = query.from; to = query.to;
  }
  if (from > to || addDays(from, 366) <= to)
    throw new BadRequestException('Период должен быть не длиннее одного года');
  return { from, to };
}
@Injectable()
export class FinanceService {
  constructor(private readonly db: DbService) {}
  async report(query: FinanceQuery) {
    const today = moscowDay(new Date());
    const { from, to } = periodBounds(query, today);
    const start = localInstant(from, 0);
    const end = localInstant(addDays(to, 1), 0);
    const [orders, cancelled, legacyCompletedCount, settings] = await Promise.all([
      this.db.order.findMany({
        where: { status: 'COMPLETED', completedAt: { gte: start, lt: end } },
        select: orderSelect, orderBy: { completedAt: 'asc' },
      }),
      this.db.order.aggregate({
        where: { status: 'CANCELED', createdAt: { gte: start, lt: end } },
        _count: { id: true }, _sum: { total: true },
      }),
      this.db.order.count({ where: { status: 'COMPLETED', completedAt: null } }),
      this.db.shopSettings.findUniqueOrThrow({ where: { id: 1 },
        select: { partner1Name: true, partner2Name: true } }),
    ]);
    const detailed = orders.map(order => {
      const lines = order.items.map(financeLine);
      const totals = financeTotals(lines, sum(order.extras.map(extra => extra.amount)), order.deliveryPrice ?? 0);
      return {
        id: order.id, publicId: order.publicId, completedAt: order.completedAt!,
        customerName: order.customerName, finalTotal: order.finalTotal,
        variance: order.finalTotal === null ? null : order.finalTotal - totals.turnover,
        lines, totals,
      };
    });
    const days = new Map<string, typeof detailed>();
    for (const order of detailed) {
      const day = moscowDay(order.completedAt);
      const rows = days.get(day) ?? [];
      rows.push(order);
      days.set(day, rows);
    }
    const daily = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const rows = days.get(date) ?? [];
      const totals = financeTotals(rows.flatMap(row => row.lines),
        sum(rows.map(row => row.totals.extras)), sum(rows.map(row => row.totals.delivery)));
      daily.push({ date, ordersCount: rows.length, ...totals });
    }
    const totals = financeTotals(detailed.flatMap(row => row.lines),
      sum(detailed.map(row => row.totals.extras)), sum(detailed.map(row => row.totals.delivery)));
    // Allocate odd kopecks across days so the day table reconciles with the period split.
    let carried = 0n;
    for (const day of daily) {
      const next = carried + BigInt(day.sharedMarkup);
      const share = splitMarkup(next).partner1Share - splitMarkup(carried).partner1Share;
      day.partner1Share = share;
      day.partner2Share = day.sharedMarkup - share;
      carried = next;
    }
    return {
      period: { from, to, timezone: 'Europe/Moscow' },
      partnerNames: [settings.partner1Name, settings.partner2Name],
      ordersCount: detailed.length,
      averageCheck: detailed.length ? Math.trunc(totals.turnover / detailed.length) : 0,
      ...totals,
      cancelled: { count: cancelled._count.id, amount: cancelled._sum.total ?? 0 },
      legacyCompletedCount,
      unreconciledOrdersCount: detailed.filter(order => order.variance !== null && order.variance !== 0).length,
      days: daily,
    };
  }
  async day(date: string) {
    const start = localInstant(date, 0);
    const end = localInstant(addDays(date, 1), 0);
    const orders = await this.db.order.findMany({
      where: { status: 'COMPLETED', completedAt: { gte: start, lt: end } },
      select: orderSelect, orderBy: { completedAt: 'asc' },
    });
    return orders.map(order => {
      const lines = order.items.map(financeLine);
      return {
        id: order.id, publicId: order.publicId, completedAt: order.completedAt,
        customerName: order.customerName, lines, finalTotal: order.finalTotal,
        totals: financeTotals(lines, sum(order.extras.map(extra => extra.amount)), order.deliveryPrice ?? 0),
      };
    });
  }
  async csv(query: FinanceQuery) {
    const report = await this.report(query);
    const header = ['Дата', 'Заказов', 'Оборот', 'С наценкой', 'Без наценки', 'Не настроено',
      'Legacy', 'База', 'Общая наценка', 'Партнёр 1', 'Партнёр 2', 'Доставка', 'Услуги'];
    const escape = (value: string | number) => {
      const text = String(value);
      const safe = /^[=+@-]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const row = (values: (string | number)[]) => values.map(escape).join(';');
    const lines = [row(header), ...report.days.map(day => row([
      day.date, day.ordersCount, day.turnover, day.sharedRevenue, day.noMarkupRevenue,
      day.unsetRevenue, day.legacyRevenue, day.baseAmount, day.sharedMarkup,
      day.partner1Share, day.partner2Share, day.delivery, day.extras,
    ]))];
    return { filename: `finance_${report.period.from}_${report.period.to}.csv`,
      body: '\uFEFF' + lines.join('\r\n') };
  }
}
