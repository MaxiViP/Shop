import { ConflictException, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { returnedProviderStatuses } from '../delivery/status.js';
import { moscowDay } from './shop-hours.js';
import type { HitAssignment, HitQuery, HitSettingsInput } from './hits.schema.js';
import { hitActive } from '../product/badges.js';

const select = { hitPeriodDays: true, hitMinOrders: true, hitShareBps: true, hitLastCalculatedAt: true } satisfies Prisma.ShopSettingsSelect;
type Settings = Prisma.ShopSettingsGetPayload<{ select: typeof select }>;
const settingsView = (settings: Settings) => ({ periodDays: settings.hitPeriodDays, minOrders: settings.hitMinOrders,
  shareBps: settings.hitShareBps, lastCalculatedAt: settings.hitLastCalculatedAt });

@Injectable()
export class HitsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly logger = new Logger(HitsService.name);
  constructor(private readonly db: DbService) {}

  onApplicationBootstrap() {
    void this.daily();
    this.timer = setInterval(() => { void this.daily(); }, 3600_000);
    this.timer.unref();
  }
  onApplicationShutdown() { clearInterval(this.timer); }
  private async daily() {
    try { await this.recalculate(false); }
    catch { this.logger.error('Не удалось пересчитать хиты; повторная попытка через час.'); }
  }

  list(query: HitQuery) {
    return this.db.$transaction(async db => {
      const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 }, select });
      const where: Prisma.ProductWhereInput = { active: true, category: { active: true },
        ...(query.category ? { categoryId: query.category } : {}),
        ...(query.hitMode ? { hitMode: query.hitMode } : {}),
        ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      };
      const items = await db.product.findMany({ where, select: { id: true, name: true, unit: true,
        category: { select: { id: true, name: true } }, hitOrders: true, hitSoldUnits: true, hitRank: true, isHit: true, hitMode: true },
        orderBy: [{ categoryId: 'asc' }, { hitRank: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit, take: query.limit });
      const total = await db.product.count({ where });
      return { settings: settingsView(settings), items: items.map(product => ({ ...product, autoHit: product.isHit, isHit: hitActive(product) })),
        total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  assign(data: HitAssignment) {
    return this.db.$transaction(async db => {
      if (await db.product.count({ where: { id: { in: data.ids } } }) !== data.ids.length)
        throw new ConflictException('Список товаров изменился. Обновите страницу.');
      const result = await db.product.updateMany({ where: { id: { in: data.ids } }, data: { hitMode: data.hitMode } });
      if (result.count !== data.ids.length) throw new ConflictException('Список товаров изменился. Обновите страницу.');
      return { count: result.count };
    });
  }

  recalculate(force = true, input?: HitSettingsInput, now = new Date()) {
    return this.db.$transaction(async db => {
      // Only one instance publishes a ranking; manual runs and settings changes use the same lock.
      const [lock] = await db.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(61893422) AS locked`;
      if (!lock?.locked) {
        if (force) throw new ConflictException('Пересчёт уже выполняется. Обновите рейтинг через минуту.');
        return { skipped: true };
      }
      let settings = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 }, select });
      if (!force && settings.hitLastCalculatedAt && moscowDay(settings.hitLastCalculatedAt) === moscowDay(now))
        return { skipped: true };
      if (input) settings = await db.shopSettings.update({ where: { id: 1 }, data: {
        hitPeriodDays: input.periodDays, hitMinOrders: input.minOrders, hitShareBps: input.shareBps,
      }, select });
      const start = new Date(now.getTime() - settings.hitPeriodDays * 86400_000);
      await db.$executeRaw(Prisma.sql`
        WITH sales AS (
          SELECT i."productId", count(DISTINCT i."orderId")::int AS orders,
            sum(i."actualQty"::numeric / CASE WHEN i.unit = 'GRAM' THEN 1000 ELSE 1 END) AS units
          FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
          WHERE o.status = 'COMPLETED' AND o."completedAt" >= ${start}::timestamp AND o."completedAt" < ${now}::timestamp
            AND i.status = 'PICKED' AND i."actualQty" > 0 AND i."actualTotal" > 0 AND i."productId" IS NOT NULL
            AND EXISTS (SELECT 1 FROM "OrderPayment" pay WHERE pay."orderId" = o.id AND pay.status = 'PAID')
            AND NOT EXISTS (SELECT 1 FROM "Delivery" d WHERE d."orderId" = o.id AND
              (d.status = 'CANCELED' OR d."providerStatus" IN (${Prisma.join(returnedProviderStatuses)})))
          GROUP BY i."productId"
        ), ranked AS (
          SELECT p.id, coalesce(s.orders, 0) AS orders, coalesce(s.units, 0) AS units,
            row_number() OVER (PARTITION BY p."categoryId" ORDER BY coalesce(s.orders, 0) DESC, coalesce(s.units, 0) DESC, p.id)::int AS rank,
            count(*) OVER (PARTITION BY p."categoryId") AS size
          FROM "Product" p JOIN "Category" c ON c.id = p."categoryId"
          LEFT JOIN sales s ON s."productId" = p.id WHERE p.active AND c.active
        ), results AS (
          SELECT p.id, r.orders, r.units, r.rank, r.size FROM "Product" p LEFT JOIN ranked r ON r.id = p.id
        )
        UPDATE "Product" p SET "isHit" = coalesce(r.orders >= ${settings.hitMinOrders} AND
            r.rank <= ceil(r.size * ${settings.hitShareBps}::numeric / 10000), false),
          "hitOrders" = coalesce(r.orders, 0), "hitSoldUnits" = coalesce(r.units, 0), "hitRank" = r.rank
        FROM results r WHERE p.id = r.id
      `);
      const saved = await db.shopSettings.update({ where: { id: 1 }, data: { hitLastCalculatedAt: now }, select });
      return { skipped: false, settings: settingsView(saved) };
    }, { timeout: 60_000 });
  }
}
