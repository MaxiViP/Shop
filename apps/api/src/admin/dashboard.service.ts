import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { FinanceService } from './finance.service.js';
import { ScheduleService } from './schedule.service.js';
import { addDays, localInstant, moscowDay } from './shop-hours.js';
@Injectable()
export class DashboardService {
  constructor(private readonly db: DbService, private readonly finance: FinanceService,
    private readonly schedule: ScheduleService) {}
  async get() {
    const [today, week, market, statuses, latest, upcomingException, ordersToday] = await Promise.all([
      this.finance.report({ period: 'today' }),
      this.finance.report({ period: 'week' }),
      this.schedule.status(),
      this.db.order.groupBy({ by: ['status'], _count: { id: true },
        where: { status: { in: ['NEW', 'ASSEMBLING', 'READY', 'DELIVERING'] } } }),
      this.db.order.findMany({ orderBy: { id: 'desc' }, take: 8,
        select: { id: true, customerName: true, createdAt: true,
          status: true, total: true, finalTotal: true } }),
      this.db.shopHoursException.findFirst({ where: { date: { gte: new Date(`${moscowDay(new Date())}T00:00:00.000Z`) } },
        orderBy: { date: 'asc' } }),
      this.db.order.count({ where: { createdAt: { gte: localInstant(moscowDay(new Date()), 0),
        lt: localInstant(addDays(moscowDay(new Date()), 1), 0) } } }),
    ]);
    return { today, ordersToday, week: week.days, market, statuses, latest, upcomingException };
  }
}
