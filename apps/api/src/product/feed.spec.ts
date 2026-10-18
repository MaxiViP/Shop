import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '../db/gen/client.js';
import { Prisma } from '../db/gen/client.js';
import { feedScope, productFeed, readFeedCursor } from './feed.js';
import { productQuerySchema } from './schema.js';

describe('Badge selections in cursor feeds', () => {
  it('binds each cursor to its hit/seasonal selection and does not reuse an unfiltered cursor', () => {
    const query = productQuerySchema.parse({ feed: 'catalog', tag: 'hit' });
    const cursor = Buffer.from(JSON.stringify({ version: 1, scope: feedScope(query), ceiling: 100,
      tail: { id: 1, name: 'Яблоки', price: 100, sort: 0, createdAt: '2026-10-10T00:00:00.000Z', categoryId: 1, categorySort: 0 },
    })).toString('base64url');
    expect(readFeedCursor({ ...query, cursor })).toBeDefined();
    expect(() => readFeedCursor({ ...query, tag: 'seasonal', cursor })).toThrow(BadRequestException);
    expect(() => readFeedCursor({ ...query, tag: undefined, cursor })).toThrow(BadRequestException);
  });

  it.each([['hit', 'catalog'], ['seasonal', 'catalog'], ['hit', 'home'], ['seasonal', 'home']] as const)(
    'combines %s in the %s feed with category/search and one bounded batch of badge cards', async (tag, feed) => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, name: 'Яблоки', price: 10000,
      sort: 0, createdAt: new Date('2026-10-10T00:00:00Z'), categoryId: 1, categorySort: 0, position: index + 1 }));
    const cards = rows.slice(0, 24).map(row => ({ ...row, marketPoint: null, isHit: true, isSeasonal: false,
      seasonalMode: 'AUTO', seasonTemplate: { active: true, startMonth: 1, endMonth: 12 } }));
    const raw = vi.fn<(sql: Prisma.Sql) => Promise<unknown>>().mockResolvedValueOnce([{ total: 25, revision: 'a'.repeat(32) }]).mockResolvedValueOnce(rows);
    const tx = { $queryRaw: raw, product: { aggregate: vi.fn().mockResolvedValue({ _max: { id: 25 } }), findMany: vi.fn().mockResolvedValue(cards) } };
    const db = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as unknown as PrismaClient;
    const result = await productFeed(db, productQuerySchema.parse({ feed, tag, category: 'fruits', q: 'яблоко' }));
    expect(result.items).toHaveLength(24);
    expect(result.items.every(item => item.isHit && item.isSeasonal)).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledTimes(2);
    for (const [sql] of raw.mock.calls) {
      expect(sql.text).toContain('ILIKE');
      expect(sql.values).toContain('%яблоко%');
      expect(sql.values).toContain('fruits');
      expect(sql.text).toContain(tag === 'hit' ? 'p."isHit"' : '"SeasonTemplate"');
    }
    const cursor = readFeedCursor({ ...productQuerySchema.parse({ feed, tag, category: 'fruits', q: 'яблоко' }), cursor: result.nextCursor! });
    expect(cursor?.tail.id).toBe(24);
  });
});

it('reuses bounded home ranks but rejects a cursor after live membership changes', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: 'Apple', price: 100,
    sort: 0, createdAt: new Date('2026-10-10T00:00:00Z'), categoryId: 1, categorySort: 0, position: i + 1 }));
  const raw = vi.fn<(sql: Prisma.Sql) => Promise<unknown>>()
    .mockResolvedValueOnce([{ total: 25, revision: 'a'.repeat(32) }]).mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([{ total: 25, revision: 'a'.repeat(32) }])
    .mockResolvedValueOnce([{ total: 24, revision: 'b'.repeat(32) }]);
  const tx = { $queryRaw: raw, product: { aggregate: async () => ({ _max: { id: 25 } }),
    findMany: async (options: { where: { id: { in: number[] } } }) => rows.filter(row => options.where.id.in.includes(row.id)).map(row => ({ ...row, marketPoint: null })) } };
  const db = { $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as unknown as PrismaClient;
  const query = productQuerySchema.parse({ feed: 'home', limit: 24 });
  const first = await productFeed(db, query);
  const second = await productFeed(db, { ...query, cursor: first.nextCursor! });
  expect(second.items.map(item => item.id)).toEqual([25]);
  expect(raw).toHaveBeenCalledTimes(3);
  await expect(productFeed(db, { ...query, cursor: first.nextCursor! })).rejects.toThrow('Каталог обновился');
});

it('searches categories on both sides of the selected category and reports an empty-category fallback', async () => {
  const row = { id: 2, name: 'Яблоки', price: 10000, sort: 0, createdAt: new Date(), categoryId: 1, categorySort: 0 };
  const raw = vi.fn<(sql: Prisma.Sql) => Promise<unknown>>().mockResolvedValueOnce([{ total: 1, current: 0 }]).mockResolvedValueOnce([row]);
  const tx = { $queryRaw: raw, product: { aggregate: async () => ({ _max: { id: 2 } }), findMany: async () => [{ ...row, marketPoint: null }] } };
  const db = { $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as unknown as PrismaClient;
  const result = await productFeed(db, productQuerySchema.parse({ feed: 'catalog', category: 'berries', q: 'яблоки' }));
  expect(result.groupTotals).toEqual({ current: 0, others: 1 });
  expect(result.items.map(item => item.id)).toEqual([2]);
  for (const [sql] of raw.mock.calls) {
    expect(sql.text).not.toContain('(c.sort, c.id) >=');
    expect(sql.text).toContain('CASE WHEN c.slug =');
  }
});
