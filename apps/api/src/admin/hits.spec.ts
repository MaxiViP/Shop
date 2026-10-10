import { ConflictException } from '@nestjs/common';
import { Client } from 'pg';
import { Prisma } from '../db/gen/client.js';
import type { DbService } from '../db/db.service.js';
import { returnedProviderStatuses } from '../delivery/status.js';
import { HitsService } from './hits.service.js';
import { hitAssignment, hitQuery, hitSettingsSchema } from './hits.schema.js';

const now = new Date('2026-10-10T09:00:00.000Z');
const defaults = { hitPeriodDays: 30, hitMinOrders: 3, hitShareBps: 1500, hitLastCalculatedAt: null as Date | null };
function fixture(initial = defaults) {
  let settings = { ...initial };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    $executeRaw: vi.fn<(sql: Prisma.Sql) => Promise<number>>().mockResolvedValue(0),
    shopSettings: {
      findUniqueOrThrow: vi.fn().mockImplementation(async () => settings),
      update: vi.fn().mockImplementation(async ({ data }: { data: Partial<typeof defaults> }) => {
        settings = { ...settings, ...data }; return settings;
      }),
    },
    product: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  return { tx, transaction, service: new HitsService({ $transaction: transaction } as unknown as DbService) };
}

describe('Hit scheduling and administration', () => {
  it.each(['AUTO', 'MANUAL', 'OFF'] as const)('bulk %s writes only the mode with a fixed query count', async hitMode => {
    const { tx, service } = fixture();
    tx.product.count.mockResolvedValue(2);
    expect(await service.assign({ ids: [1, 2], hitMode })).toEqual({ count: 2 });
    expect(tx.product.count).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: [1, 2] } }, data: { hitMode } });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('rejects invented statistics, duplicate IDs and incomplete selections', async () => {
    expect(hitAssignment.safeParse({ ids: [1, 1], hitMode: 'MANUAL' }).success).toBe(false);
    expect(hitAssignment.safeParse({ ids: [1], hitMode: 'MANUAL', hitOrders: 100 }).success).toBe(false);
    const { tx, service } = fixture();
    await expect(service.assign({ ids: [1, 2], hitMode: 'MANUAL' })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
  it('skips only the same Moscow day and recalculates when UTC 21:00 starts the next day', async () => {
    const { tx, service } = fixture({ ...defaults, hitLastCalculatedAt: new Date('2026-10-10T09:00:00Z') });
    expect(await service.recalculate(false, undefined, new Date('2026-10-10T20:59:59.999Z'))).toEqual({ skipped: true });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect((await service.recalculate(false, undefined, new Date('2026-10-10T21:00:00Z'))).skipped).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('starts automatic checks, retries hourly and clears its timer on shutdown', async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    const recalculate = vi.spyOn(service, 'recalculate').mockResolvedValue({ skipped: true });
    try {
      service.onApplicationBootstrap();
      expect(recalculate).toHaveBeenCalledWith(false);
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(recalculate).toHaveBeenCalledTimes(2);
      service.onApplicationShutdown();
      expect(vi.getTimerCount()).toBe(0);
    } finally { service.onApplicationShutdown(); vi.useRealTimers(); }
  });

  it('prevents overlapping automatic and manual recalculations without publishing a partial ranking', async () => {
    const { tx, service } = fixture();
    tx.$queryRaw.mockResolvedValue([{ locked: false }]);
    expect(await service.recalculate(false)).toEqual({ skipped: true });
    await expect(service.recalculate()).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.shopSettings.update).not.toHaveBeenCalled();
  });

  it('saves validated settings and publishes one ranking with defaults 30 days, 3 orders and 15%', async () => {
    const { tx, service } = fixture();
    const input = hitSettingsSchema.parse({ periodDays: 14, minOrders: 5, shareBps: 2000 });
    const result = await service.recalculate(true, input, now);
    expect(result).toMatchObject({ skipped: false, settings: { ...input, lastCalculatedAt: now } });
    expect(tx.shopSettings.update).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(hitSettingsSchema.safeParse({ periodDays: 0, minOrders: 0, shareBps: 10001 }).success).toBe(false);
  });

  it('lists paginated statistics with a fixed number of queries and no per-product requests', async () => {
    const { tx, service } = fixture();
    const items = Array.from({ length: 24 }, (_, id) => ({ id, hitOrders: 3, hitSoldUnits: new Prisma.Decimal('5.003'), isHit: true }));
    tx.product.findMany.mockResolvedValue(items);
    tx.product.count.mockResolvedValue(48);
    const result = await service.list(hitQuery.parse({ category: 1, search: 'Яблоки', page: 2, limit: 24 }));
    expect(result).toMatchObject({ items: items.map(item => ({ ...item, autoHit: true })), total: 48, page: 2, pages: 2, settings: { periodDays: 30, minOrders: 3, shareBps: 1500 } });
    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(tx.product.count).toHaveBeenCalledTimes(1);
    expect(tx.shopSettings.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(tx.product.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 24, take: 24, where: expect.objectContaining({ categoryId: 1, active: true, category: { active: true } }),
    }));
  });
});

// This optional profile executes the production UPDATE on session-local temporary tables.
// It starts no application, uses no migrations and rolls all fixture writes back.
const testUrl = process.env.BADGES_TEST_DATABASE_URL;
describe.skipIf(!testUrl)('Hit SQL on isolated PostgreSQL temporary tables', () => {
  let client: Client;
  let orderId = 0;
  beforeAll(async () => {
    if (!testUrl || !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/.test(testUrl))
      throw new Error('Use an explicit local test database URL');
    client = new Client({ connectionString: testUrl });
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE "Category" (id int PRIMARY KEY, active boolean NOT NULL);
      CREATE TEMP TABLE "Product" (id int PRIMARY KEY, "categoryId" int NOT NULL, active boolean NOT NULL,
        "isHit" boolean NOT NULL DEFAULT false, "hitOrders" int NOT NULL DEFAULT 0,
        "hitSoldUnits" numeric(24,3) NOT NULL DEFAULT 0, "hitRank" int);
      CREATE TEMP TABLE "Order" (id int PRIMARY KEY, status text NOT NULL, "completedAt" timestamp);
      CREATE TEMP TABLE "OrderItem" ("orderId" int, "productId" int, unit text, status text, "actualQty" int, "actualTotal" int);
      CREATE TEMP TABLE "OrderPayment" ("orderId" int UNIQUE, status text);
      CREATE TEMP TABLE "Delivery" ("orderId" int UNIQUE, status text, "providerStatus" text);
    `);
  });
  beforeEach(async () => {
    orderId = 0;
    await client.query('BEGIN');
    await client.query('INSERT INTO "Category" VALUES (1, true), (2, true)');
    await client.query('INSERT INTO "Product" (id, "categoryId", active) SELECT id, CASE WHEN id <= 10 THEN 1 ELSE 2 END, true FROM generate_series(1,13) id');
  });
  afterEach(async () => { if (client) await client.query('ROLLBACK'); });
  afterAll(async () => { if (client) await client.end(); });

  async function sale(productId: number, qty: number, options: {
    status?: string; age?: number; payment?: string | null; returned?: string; canceledDelivery?: boolean;
    duplicate?: boolean; missing?: boolean; zero?: boolean;
  } = {}) {
    const id = ++orderId;
    await client.query('INSERT INTO "Order" VALUES ($1,$2,$3)', [id, options.status ?? 'COMPLETED', new Date(now.getTime() - (options.age ?? 1000))]);
    for (let line = 0; line < (options.duplicate ? 2 : 1); line++)
      await client.query('INSERT INTO "OrderItem" VALUES ($1,$2,$3,$4,$5,$6)',
        [id, productId, productId === 11 ? 'GRAM' : 'PIECE', options.missing ? 'MISSING' : 'PICKED', qty, options.zero ? 0 : 100]);
    if (options.payment !== null)
      await client.query('INSERT INTO "OrderPayment" VALUES ($1,$2)', [id, options.payment ?? 'PAID']);
    if (options.returned || options.canceledDelivery)
      await client.query('INSERT INTO "Delivery" VALUES ($1,$2,$3)', [id, options.canceledDelivery ? 'CANCELED' : 'DELIVERED', options.returned ?? null]);
  }
  async function recalculate() {
    const { tx, service } = fixture();
    tx.$executeRaw.mockImplementation(async sql => {
      const result = await client.query(sql.text, sql.values); return result.rowCount ?? 0;
    });
    await service.recalculate(true, undefined, now);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    return (await client.query<{ id: number; hitOrders: number; hitSoldUnits: string; isHit: boolean; hitRank: number | null }>(
      'SELECT * FROM "Product" ORDER BY "categoryId", "hitRank" NULLS LAST, id')).rows;
  }

  it('ranks unique paid completed orders, actual units and stable ties within each category', async () => {
    for (let index = 0; index < 4; index++) await sale(1, 1, { duplicate: index === 0 });
    for (let index = 0; index < 3; index++) {
      await sale(2, 5); await sale(3, 5); await sale(11, 1001);
    }
    for (let index = 0; index < 2; index++) await sale(4, 100);
    for (const status of ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'CANCELED']) await sale(4, 100, { status });
    for (const payment of ['AWAITING', 'REPORTED', 'CANCELED', null]) await sale(4, 100, { payment });
    for (const returned of returnedProviderStatuses) await sale(4, 100, { returned });
    await sale(4, 100, { canceledDelivery: true });
    await sale(4, 100, { missing: true });
    await sale(4, 100, { zero: true });
    await sale(4, 0);
    await sale(4, 100, { age: 31 * 86400_000 });
    await sale(4, 100, { age: -86400_000 });
    const rows = await recalculate();
    expect(rows.slice(0, 4).map(row => [row.id, row.hitOrders, Number(row.hitSoldUnits), row.isHit]))
      .toEqual([[1, 4, 5, true], [2, 3, 15, true], [3, 3, 15, false], [4, 2, 200, false]]);
    expect(rows.find(row => row.id === 11)).toMatchObject({ isHit: true, hitOrders: 3, hitSoldUnits: '3.003' });
  });

  it('includes the exact 30-day start, excludes older and future sales, and clears stale fake badges', async () => {
    await sale(1, 1); await sale(1, 1, { age: 30 * 86400_000 }); await sale(1, 1, { age: 2000 });
    await sale(1, 100, { age: 30 * 86400_000 + 1 }); await sale(1, 100, { age: 0 });
    await client.query('UPDATE "Product" SET "isHit" = true, "hitOrders" = 999, "hitSoldUnits" = 999 WHERE id = 4');
    for (let index = 0; index < 3; index++) await sale(4, 100, { payment: null });
    const rows = await recalculate();
    expect(rows.find(row => row.id === 1)).toMatchObject({ hitOrders: 3, hitSoldUnits: '3.000', isHit: true });
    expect(rows.find(row => row.id === 4)).toMatchObject({ hitOrders: 0, hitSoldUnits: '0.000', isHit: false });
  });

  it('resets hidden products and inactive categories instead of retaining their old hit flags', async () => {
    for (let index = 0; index < 3; index++) { await sale(1, 1); await sale(11, 1000); }
    await client.query('UPDATE "Product" SET "isHit" = true, active = false WHERE id = 1');
    await client.query('UPDATE "Category" SET active = false WHERE id = 2');
    const rows = await recalculate();
    expect(rows.some(row => row.isHit)).toBe(false);
    expect(rows.find(row => row.id === 1)?.hitRank).toBeNull();
    expect(rows.find(row => row.id === 11)?.hitOrders).toBe(0);
  });
});
