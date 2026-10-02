import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { QueueService } from '../order/queue.js';
import { isMarketOpenAt, loadCalendar, marketStatusAt } from './shop-hours.js';
import type { ExceptionInput, WeeklyInput } from './schedule.schema.js';

function isUniqueError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class ScheduleService {
  constructor(private readonly db: DbService) {}
  private async protectBookings(db: Prisma.TransactionClient,
    before: Awaited<ReturnType<typeof loadCalendar>>) {
    const booked = await db.order.findMany({ where: { fulfillmentMode: 'SCHEDULED',
      scheduledFor: { gte: new Date() }, status: { notIn: ['COMPLETED', 'CANCELED'] } },
      select: { scheduledFor: true } });
    if (!booked.length) return;
    const after = await loadCalendar(db);
    const { minutes } = await new QueueService(this.db).snapshot(db);
    for (const row of booked) {
      const ready = row.scheduledFor!;
      const start = new Date(ready.getTime() - minutes * 60_000);
      if (isMarketOpenAt(before, ready) && isMarketOpenAt(before, start) &&
        (!isMarketOpenAt(after, ready) || !isMarketOpenAt(after, start)))
        throw new ConflictException('Изменение графика затронет уже принятый заказ ко времени.');
    }
  }
  async status() {
    return marketStatusAt(await loadCalendar(this.db), new Date());
  }
  async get() {
    const [weekly, exceptions, status] = await Promise.all([
      this.db.shopHours.findMany({ orderBy: { weekday: 'asc' } }),
      this.db.shopHoursException.findMany({ orderBy: { date: 'asc' } }),
      this.status(),
    ]);
    return { weekly, exceptions, status };
  }
  updateWeekly(weekday: number, input: WeeklyInput, actorId: number) {
    return this.db.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
      const before = await loadCalendar(db);
      await db.$queryRaw`SELECT weekday FROM "ShopHours" WHERE weekday = ${weekday} FOR UPDATE`;
      const previous = await db.shopHours.findUnique({ where: { weekday } });
      if (!previous) throw new NotFoundException();
      const saved = await db.shopHours.update({
        where: { weekday },
        data: input,
      });
      await this.protectBookings(db, before);
      await db.adminAudit.create({
        data: {
          actorId,
          action: 'SCHEDULE_WEEKLY_CHANGED',
          entity: 'SHOP_HOURS',
          entityId: String(weekday),
          oldValue: previous,
          newValue: saved,
        },
      });
      return saved;
    });
  }
  async createException(input: ExceptionInput, actorId: number) {
    const date = new Date(`${input.date}T00:00:00.000Z`);
    const exists = await this.db.shopHoursException.findUnique({
      where: { date },
    });
    if (exists) throw new ConflictException('Особый день уже существует');
    try {
      return await this.db.$transaction(async (db) => {
        await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
        const before = await loadCalendar(db);
        const saved = await db.shopHoursException.create({
          data: { ...input, date },
        });
        await this.protectBookings(db, before);
        await db.adminAudit.create({
          data: {
            actorId,
            action: 'SCHEDULE_EXCEPTION_CREATED',
            entity: 'SHOP_HOURS_EXCEPTION',
            entityId: String(saved.id),
            newValue: input,
          },
        });
        return saved;
      });
    } catch (error) {
      if (isUniqueError(error))
        throw new ConflictException('Особый день уже существует');
      throw error;
    }
  }
  async updateException(id: number, input: ExceptionInput, actorId: number) {
    try {
      return await this.db.$transaction(async (db) => {
        await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
        const before = await loadCalendar(db);
        await db.$queryRaw`SELECT id FROM "ShopHoursException" WHERE id = ${id} FOR UPDATE`;
        const previous = await db.shopHoursException.findUnique({
          where: { id },
        });
        if (!previous) throw new NotFoundException();
        const saved = await db.shopHoursException.update({
          where: { id },
          data: { ...input, date: new Date(`${input.date}T00:00:00.000Z`) },
        });
        await this.protectBookings(db, before);
        await db.adminAudit.create({
          data: {
            actorId,
            action: 'SCHEDULE_EXCEPTION_CHANGED',
            entity: 'SHOP_HOURS_EXCEPTION',
            entityId: String(id),
            oldValue: {
              date: previous.date.toISOString().slice(0, 10),
              closed: previous.closed,
              openMinutes: previous.openMinutes,
              closeMinutes: previous.closeMinutes,
              note: previous.note,
            },
            newValue: input,
          },
        });
        return saved;
      });
    } catch (error) {
      if (isUniqueError(error))
        throw new ConflictException('Особый день уже существует');
      throw error;
    }
  }
  deleteException(id: number, actorId: number) {
    return this.db.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
      const before = await loadCalendar(db);
      await db.$queryRaw`SELECT id FROM "ShopHoursException" WHERE id = ${id} FOR UPDATE`;
      const previous = await db.shopHoursException.findUnique({
        where: { id },
      });
      if (!previous) throw new NotFoundException();
      await db.shopHoursException.delete({ where: { id } });
      await this.protectBookings(db, before);
      await db.adminAudit.create({
        data: {
          actorId,
          action: 'SCHEDULE_EXCEPTION_DELETED',
          entity: 'SHOP_HOURS_EXCEPTION',
          entityId: String(id),
          oldValue: {
            date: previous.date.toISOString().slice(0, 10),
            closed: previous.closed,
            openMinutes: previous.openMinutes,
            closeMinutes: previous.closeMinutes,
            note: previous.note,
          },
        },
      });
      return { ok: true };
    });
  }
}
