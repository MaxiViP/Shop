import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { ProductModule } from '../src/product/product.module.js';
import { CategoryModule } from '../src/category/category.module.js';
import type { ProductSort } from '../src/product/schema.js';

interface Card { id: number; name: string; price: number; category: { slug: string }; marketPoint: { slug: string } | null }
interface Feed { items: Card[]; total: number; nextCursor: string | null; seed?: string }
type Query = Record<string, string | number>;

describe.skipIf(!process.env.DATABASE_URL)('product feed / local PostgreSQL', () => {
  const schema = `product_feed_test_${randomUUID().replaceAll('-', '')}`;
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>;
  let created = false;
  const seed = '00000000-0000-4000-8000-000000000001';
  const categoryIds = new Map<string, number>();
  const http = () => request(app.getHttpServer());
  const page = async (query: Query): Promise<Feed> =>
    (await http().get('/api/products').query(query).expect(200)).body as Feed;
  async function walk(query: Query, first?: Feed) {
    const items: Card[] = [], cursors = new Set<string>();
    let result = first ?? await page(query);
    for (let count = 0; count < 200; count++) {
      expect(result.items.length).toBeLessThanOrEqual(Number(query.limit ?? 24));
      items.push(...result.items);
      if (!result.nextCursor) {
        expect(new Set(items.map(item => item.id)).size).toBe(items.length);
        return items;
      }
      expect(cursors.has(result.nextCursor)).toBe(false);
      cursors.add(result.nextCursor);
      result = await page({ ...query, cursor: result.nextCursor });
    }
    throw new Error('Feed did not end');
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local database required');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^product_feed_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    const module = await Test.createTestingModule({ imports: [ProductModule, CategoryModule] })
      .overrideProvider(DbService).useValue(db).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.setGlobalPrefix('api'); app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    const categories = [
      ['feed-before', 'Ранее'], ['feed-fruits', 'Фрукты'], ['feed-empty', 'Пустая'],
      ['feed-vegetables', 'Овощи'], ['feed-greens', 'Зелень'], ['feed-last-empty', 'Пустая в конце'],
    ] as const;
    for (const [index, [slug, name]] of categories.entries()) {
      const category = await db.category.create({ data: { slug, name, sort: index } });
      categoryIds.set(slug, category.id);
    }
    const base = { unit: 'PIECE' as const, priceQty: 1, min: 1, step: 1, portionQty: 1 };
    for (let point = 0; point < 6; point++) {
      const market = await db.marketPoint.create({ data: { slug: `feed-point-${point}`, name: `Feed seller ${point}`,
        kind: 'STALL', floor: 2, mapX: null, mapY: null, isPublished: true } });
      for (const slug of ['feed-before', 'feed-fruits', 'feed-vegetables', 'feed-greens'])
        for (let index = 0; index < (point === 0 ? 15 : 3); index++)
          await db.product.create({ data: { ...base, categoryId: categoryIds.get(slug)!, marketPointId: market.id,
            slug: `${slug}-${point}-${index}`, name: `Feed product ${index % 3}`, price: 10000 + index % 4 * 100,
            sort: index % 2, createdAt: new Date(`2026-10-0${1 + index % 3}T00:00:00Z`) } });
    }
    await db.product.create({ data: { ...base, categoryId: categoryIds.get('feed-fruits')!,
      slug: 'feed-hidden', name: 'Feed hidden', price: 10000, active: false } });
  }, 60000);

  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^product_feed_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end();
  });

  it.each(['recommended', 'price_asc', 'price_desc', 'name', 'newest'] as const)('paginates all products in %s order without repeats or omissions, including ties', async (sort: ProductSort) => {
    const orderBy = sort === 'price_asc' ? [{ price: 'asc' as const }, { name: 'asc' as const }, { id: 'asc' as const }]
      : sort === 'price_desc' ? [{ price: 'desc' as const }, { name: 'asc' as const }, { id: 'asc' as const }]
        : sort === 'newest' ? [{ createdAt: 'desc' as const }, { name: 'asc' as const }, { id: 'asc' as const }]
          : sort === 'name' ? [{ name: 'asc' as const }, { id: 'asc' as const }]
            : [{ sort: 'asc' as const }, { name: 'asc' as const }, { id: 'asc' as const }];
    const expected = await db.product.findMany({ where: { active: true }, orderBy, select: { id: true, price: true } });
    const cards = await walk({ feed: 'catalog', sort, limit: 7 });
    expect(cards.map(item => item.id)).toEqual(expected.map(item => item.id));
    expect(cards[0]!.price).toBe(Math.round(expected[0]!.price * 1.1));
    expect(cards[0]).not.toHaveProperty('sellerPrice');
  });

  it('continues Фрукты → Овощи → Зелень, skips empty categories, and never wraps to earlier categories', async () => {
    const cards = await walk({ feed: 'catalog', category: 'feed-fruits', sort: 'price_desc', limit: 7 });
    const slugs = [...new Set(cards.map(item => item.category.slug))];
    expect(slugs).toEqual(['feed-fruits', 'feed-vegetables', 'feed-greens']);
    for (const slug of slugs) {
      const prices = cards.filter(item => item.category.slug === slug).map(item => item.price);
      expect(prices).toEqual(prices.toSorted((a, b) => b - a));
    }
    expect((await page({ feed: 'catalog', category: 'feed-last-empty' })).nextCursor).toBeNull();
    expect((await page({ feed: 'catalog', category: 'feed-empty' })).items[0]?.category.slug).toBe('feed-vegetables');
  });

  it('keeps search and MarketPoint filters on every category/page and rejects a cursor reused under other filters', async () => {
    const query = { feed: 'catalog', category: 'feed-fruits', q: 'Feed product 1', marketPoint: 'feed-point-0', limit: 3 };
    const first = await page(query);
    const cards = await walk(query, first);
    expect(cards.length).toBe(first.total);
    expect(cards.every(item => item.name === 'Feed product 1' && item.marketPoint?.slug === 'feed-point-0')).toBe(true);
    await http().get('/api/products').query({ ...query, cursor: first.nextCursor, sort: 'name' }).expect(400);
    await http().get('/api/products').query({ ...query, cursor: first.nextCursor, q: 'another' }).expect(400);
  });

  it('uses the same seeded home sequence across page sizes and fresh requests, with early seller/category diversity', async () => {
    const first = await page({ feed: 'home', seed, limit: 24 });
    expect(new Set(first.items.map(item => item.marketPoint?.slug)).size).toBe(6);
    expect(new Set(first.items.map(item => item.category.slug)).size).toBe(4);
    const small = await walk({ feed: 'home', seed, limit: 7 });
    const large = await walk({ feed: 'home', seed, limit: 24 });
    expect(small.map(item => item.id)).toEqual(large.map(item => item.id));
    expect(small).toHaveLength(await db.product.count({ where: { active: true } }));
    const another = await page({ feed: 'home', seed: '00000000-0000-4000-8000-000000000002', limit: 24 });
    expect(another.items.map(item => item.id)).not.toEqual(first.items.map(item => item.id));
  });

  it('generates a seed for a new visit and carries it in the cursor for subsequent pages', async () => {
    const first = await page({ feed: 'home', limit: 7 });
    expect(first.seed).toMatch(/^[a-f0-9-]{36}$/);
    const next = await page({ feed: 'home', cursor: first.nextCursor!, limit: 7 });
    expect(next.seed).toBe(first.seed);
    expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(14);
    expect((await page({ feed: 'home', limit: 7 })).seed).not.toBe(first.seed);
  });

  it('includes every seller and rare categories before repeating a large common assortment', async () => {
    const points = await db.marketPoint.findMany({ where: { slug: { startsWith: 'feed-point-' } }, orderBy: { id: 'asc' } });
    const data: Prisma.ProductCreateManyInput[] = [];
    for (const [index, point] of points.entries()) {
      const base = { marketPointId: point.id, price: 10000, unit: 'PIECE' as const, priceQty: 1, min: 1, step: 1, portionQty: 1 };
      for (let number = 0; number < 12; number++) data.push({ ...base, name: 'Coverage common',
        slug: `coverage-${index}-${number}`, categoryId: categoryIds.get('feed-fruits')! });
      const rare = ['feed-greens', 'feed-vegetables', 'feed-before'][index];
      if (rare) data.push({ ...base, name: 'Coverage rare', slug: `coverage-rare-${index}`, categoryId: categoryIds.get(rare)! });
    }
    await db.product.createMany({ data });
    try {
      const first = await page({ feed: 'home', q: 'Coverage', seed, limit: 6 });
      expect(new Set(first.items.map(item => item.marketPoint?.slug)).size).toBe(6);
      expect(new Set(first.items.map(item => item.category.slug)).size).toBe(4);
    } finally { await db.product.deleteMany({ where: { slug: { startsWith: 'coverage-' } } }); }
  });

  it('excludes products added after the first cursor and remains valid after a preceding product is deleted', async () => {
    const first = await page({ feed: 'catalog', sort: 'name', limit: 7 });
    const original = await db.product.findMany({ where: { active: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true } });
    const added = await db.product.create({ data: { name: 'Feed new product', slug: 'feed-added-after-cursor',
      categoryId: categoryIds.get('feed-fruits')!, price: 10000, unit: 'PIECE', min: 1, step: 1, portionQty: 1 } });
    const removed = await db.product.findUniqueOrThrow({ where: { id: first.items[0]!.id } });
    await db.product.delete({ where: { id: removed.id } });
    try {
      const cards = await walk({ feed: 'catalog', sort: 'name', limit: 7 }, first);
      expect(cards.map(item => item.id)).toEqual(original.map(item => item.id));
      expect(cards.some(item => item.id === added.id)).toBe(false);
    } finally {
      await db.product.delete({ where: { id: added.id } });
      await db.product.create({ data: removed });
    }
  });

  it('returns an empty terminal page and validates bounded requests', async () => {
    expect(await page({ feed: 'catalog', q: 'no such item' })).toMatchObject({ items: [], total: 0, nextCursor: null });
    for (const query of [{ feed: 'home', limit: 25 }, { feed: 'catalog', page: 2 }, { feed: 'home', cursor: 'invalid' }])
      await http().get('/api/products').query(query).expect(400);
  });

  it('rejects a home cursor after catalogue membership changes instead of silently shifting seeded ranks', async () => {
    const first = await page({ feed: 'home', seed, limit: 7 });
    const removed = await db.product.findUniqueOrThrow({ where: { id: first.items[0]!.id } });
    await db.product.delete({ where: { id: removed.id } });
    try {
      await http().get('/api/products').query({ feed: 'home', seed, cursor: first.nextCursor, limit: 7 }).expect(409);
    } finally { await db.product.create({ data: removed }); }
  });
});
