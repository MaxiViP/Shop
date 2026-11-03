import {
  ForbiddenException,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../db/db.service.js';
import { Prisma } from '../db/gen/client.js';
import type { AdminChange } from '../db/gen/client.js';
import { adminPhone } from '../auth/admin.config.js';
import {
  cursorScope,
  eventWhere,
  readEventCursor,
  signEventCursor,
  type EventsQuery,
} from './events-query.js';

type FeedEvent = Pick<
  AdminChange,
  | 'id'
  | 'requestId'
  | 'actorId'
  | 'actorName'
  | 'actorRole'
  | 'source'
  | 'category'
  | 'title'
  | 'entity'
  | 'entityId'
  | 'operation'
  | 'beforeValue'
  | 'afterValue'
  | 'orderId'
  | 'productId'
  | 'createdAt'
  | 'ownerOnly'
>;
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(EventsService.name);
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.retain().catch(() =>
        this.logger.warn('Event retention failed'),
      );
    }, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  constructor(private readonly db: DbService) {}
  async failure(
    requestId: string,
    user: { id: number; role: string; name: string | null } | null | undefined,
    ownerOnly: boolean,
  ) {
    const staff = user?.role === 'ADMIN' || user?.role === 'SELLER';
    const dedupeKey = createHash('md5')
      .update('failure:' + requestId)
      .digest('hex');
    await this.db.adminChange.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        dedupeKey,
        requestId,
        actorId: user?.id,
        actorName: staff
          ? user.name || `Сотрудник #${user.id}`
          : user
            ? 'Покупатель'
            : 'Система',
        actorRole: user ? (staff ? user.role : 'CUSTOMER') : 'SYSTEM',
        source: 'WEB',
        category: 'SYSTEM',
        title: 'Операция не выполнена',
        entity: 'System',
        entityId: requestId,
        operation: 'ERROR',
        afterValue: { code: 'INTERNAL_ERROR' },
        ownerOnly,
        notifyOwner: false,
        status: 'SENT',
      },
    });
  }
  async access(userId: number) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { role: true, phone: true },
    });
    if (!user || user.role !== 'ADMIN' || !user.phone || !adminPhone())
      throw new ForbiddenException();
    return user.phone === adminPhone();
  }
  async list(userId: number, query: EventsQuery) {
    const primary = await this.access(userId);
    const where = eventWhere(query, primary);
    return this.db.$transaction(
      async (db) => {
        const [snapshot] = await db.$queryRaw<
          { value: string }[]
        >`SELECT pg_current_snapshot()::text AS value`;
        const items = await db.$queryRaw<FeedEvent[]>(Prisma.sql`
        SELECT e.id,e."requestId",e."actorId",e."actorName",e."actorRole",e.source,e.category,e.title,
          e.entity,e."entityId",e.operation,e."beforeValue",e."afterValue",e."orderId",e."productId",e."createdAt",e."ownerOnly"
        FROM "AdminChange" e WHERE ${where} ${query.before ? Prisma.sql`AND e.id<${query.before}` : Prisma.empty}
        ORDER BY e.id DESC LIMIT 41`);
        const [count] = await db.$queryRaw<{ total: number }[]>(
          Prisma.sql`SELECT count(*)::int AS total FROM "AdminChange" e WHERE ${where}`,
        );
        const actors = await db.$queryRaw<
          { id: number; name: string }[]
        >(Prisma.sql`
        SELECT e."actorId" AS id,max(e."actorName") AS name FROM "AdminChange" e
        WHERE ${primary ? Prisma.sql`TRUE` : Prisma.sql`e."ownerOnly"=false`} AND e."actorId" IS NOT NULL AND e."actorRole" IN ('ADMIN','SELLER')
        GROUP BY e."actorId" ORDER BY max(e.id) DESC LIMIT 120`);
        return {
          items: items.slice(0, 40),
          total: count!.total,
          next: items.length > 40 ? items[39]!.id : null,
          primary,
          actors,
          cursor: signEventCursor(
            snapshot!.value,
            cursorScope(userId, primary, query),
          ),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async changes(userId: number, query: EventsQuery, token?: string) {
    const primary = await this.access(userId);
    const scope = cursorScope(userId, primary, query);
    const old = token ? readEventCursor(token, scope) : null;
    return this.db.$transaction(
      async (db) => {
        const [snapshot] = await db.$queryRaw<
          { value: string }[]
        >`SELECT pg_current_snapshot()::text AS value`;
        let count = 0;
        if (old) {
          // ID sequences are allocated before commit. Snapshot visibility also
          // recovers a lower-ID transaction committed after its neighbours.
          const [result] = await db.$queryRaw<{ count: number }[]>(Prisma.sql`
          SELECT count(*)::int AS count FROM "AdminChange" e WHERE ${eventWhere(query, primary)}
          AND e."txId">=${BigInt(old.snapshot.split(':')[0]!)}
          AND NOT pg_visible_in_snapshot(e."txId"::text::xid8,${old.snapshot}::pg_snapshot)`);
          count = result!.count;
        }
        return { count, cursor: signEventCursor(snapshot!.value, scope) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async retain() {
    const days = Number(process.env.EVENT_RETENTION_DAYS ?? 180);
    if (!Number.isInteger(days) || days < 30 || days > 3650)
      throw new Error('Invalid EVENT_RETENTION_DAYS');
    const cutoff = new Date(Date.now() - days * 86400000);
    // Bounded deletion. Unresolved Telegram deliveries stay available for owner review.
    return this.db.$executeRaw`DELETE FROM "AdminChange" WHERE id IN
      (SELECT id FROM "AdminChange" WHERE "createdAt"<${cutoff} AND status='SENT' ORDER BY "createdAt" LIMIT 1000)`;
  }
}
