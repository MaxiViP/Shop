import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../db/gen/client.js';
import type { ProductQuery } from './schema.js';
import { customerProduct, productListSelect } from './select.js';
import { hitSql, seasonalSql } from './badges.js';

const tailSchema = z.object({
  id: z.number().int().positive(), name: z.string().max(1000),
  price: z.number().int(), sort: z.number().int(), createdAt: z.iso.datetime(),
  categorySort: z.number().int(), categoryId: z.number().int().positive(),
  position: z.number().int().positive().optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1), scope: z.string().length(64),
  ceiling: z.number().int().nonnegative(), seed: z.uuid().optional(), revision: z.string().regex(/^[a-f0-9]{32}$/).optional(), tail: tailSchema,
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
type FeedRow = Omit<Cursor['tail'], 'createdAt'> & { createdAt: Date };
type Key = { column: keyof Cursor['tail']; direction: 'asc' | 'desc' };

export function feedScope(query: ProductQuery) {
  return createHash('sha256').update(JSON.stringify({
    feed: query.feed, category: query.category ?? null, q: query.q ?? null,
    marketPoint: query.marketPoint ?? null, ids: query.ids?.toSorted((a, b) => a - b) ?? null,
    sort: query.sort,
    tag: query.tag ?? null,
  })).digest('hex');
}

export function readFeedCursor(query: ProductQuery): Cursor | undefined {
  if (!query.cursor) return;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
    if (cursor.scope !== feedScope(query) ||
      (query.feed === 'home' && (!cursor.seed || !cursor.tail.position || !cursor.revision)) ||
      (query.seed && query.seed !== cursor.seed)) throw new Error('Cursor scope changed');
    return cursor;
  } catch {
    throw new BadRequestException('Некорректная страница товаров. Обновите выдачу.');
  }
}

function keys(query: ProductQuery): Key[] {
  if (query.feed === 'home') return [{ column: 'position', direction: 'asc' }];
  const prefix: Key[] = query.category
    ? [{ column: 'categorySort', direction: 'asc' }, { column: 'categoryId', direction: 'asc' }] : [];
  const primary: Key[] = query.sort === 'price_asc' ? [{ column: 'price', direction: 'asc' }]
    : query.sort === 'price_desc' ? [{ column: 'price', direction: 'desc' }]
      : query.sort === 'newest' ? [{ column: 'createdAt', direction: 'desc' }]
        : query.sort === 'recommended' ? [{ column: 'sort', direction: 'asc' }] : [];
  return [...prefix, ...primary, { column: 'name', direction: 'asc' }, { column: 'id', direction: 'asc' }];
}

const column = (key: Key) => Prisma.raw('"' + key.column + '"');
function value(key: Key, tail: Cursor['tail']) {
  return key.column === 'createdAt' ? Prisma.sql`${new Date(tail.createdAt)}::timestamp`
    : Prisma.sql`${tail[key.column]}`;
}
function after(order: Key[], tail?: Cursor['tail']) {
  if (!tail) return Prisma.sql`TRUE`;
  return Prisma.sql`(${Prisma.join(order.map((key, index) => {
    const equal = order.slice(0, index).map(previous => Prisma.sql`${column(previous)} = ${value(previous, tail)}`);
    const next = Prisma.sql`${column(key)} ${Prisma.raw(key.direction === 'asc' ? '>' : '<')} ${value(key, tail)}`;
    return Prisma.sql`(${Prisma.join([...equal, next], ' AND ')})`;
  }), ' OR ')})`;
}

// Ranking stays on PostgreSQL. Only a bounded page of IDs and product cards leaves the database.
// A fixed seed, ID ceiling and deterministic tie breakers keep subsequent pages in the same shuffle.
// Each seller gets one card per round; categories sold by fewer sellers lead its round.
// Membership changes invalidate home ranks; old cards remain visible until an explicit refresh.
export async function productFeed(db: PrismaClient, query: ProductQuery) {
  const cursor = readFeedCursor(query);
  const seed = query.feed === 'home' ? cursor?.seed ?? query.seed ?? randomUUID() : undefined;
  return db.$transaction(async tx => {
    const ceiling = cursor?.ceiling ?? (await tx.product.aggregate({ _max: { id: true } }))._max.id ?? 0;
    const filters = [Prisma.sql`p.active AND c.active AND p.id <= ${ceiling}`];
    if (query.tag === 'hit') filters.push(hitSql());
    if (query.tag === 'seasonal') {
      filters.push(seasonalSql(new Date()));
    }
    if (query.category) filters.push(query.feed === 'catalog'
      ? Prisma.sql`(c.sort, c.id) >= (SELECT sort, id FROM "Category" WHERE slug = ${query.category} AND active)`
      : Prisma.sql`c.slug = ${query.category}`);
    if (query.marketPoint) filters.push(Prisma.sql`m.slug = ${query.marketPoint} AND m."isPublished"`);
    if (query.ids) filters.push(query.ids.length ? Prisma.sql`p.id IN (${Prisma.join(query.ids)})` : Prisma.sql`FALSE`);
    if (query.q) {
      const text = '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%';
      filters.push(Prisma.sql`(p.name ILIKE ${text} OR p.description ILIKE ${text})`);
    }
    const pool = Prisma.sql`SELECT p.id, p.name, p.price, p.sort, p."createdAt", p."marketPointId",
      c.id AS "categoryId", c.sort AS "categorySort"
      FROM "Product" p JOIN "Category" c ON c.id = p."categoryId"
      LEFT JOIN "MarketPoint" m ON m.id = p."marketPointId"
      WHERE ${Prisma.join(filters, ' AND ')}`;
    const counts = await tx.$queryRaw<{ total: number; revision: string | null }[]>(Prisma.sql`
      SELECT count(*)::int AS total, ${query.feed === 'home'
        ? Prisma.sql`md5(coalesce(string_agg(jsonb_build_array(id, "marketPointId", "categoryId")::text, ',' ORDER BY id), ''))`
        : Prisma.sql`NULL::text`} AS revision FROM (${pool}) matching`);
    const revision = counts[0]?.revision ?? undefined;
    if (query.feed === 'home' && cursor && cursor.revision !== revision)
      throw new ConflictException('Каталог обновился. Обновите витрину, чтобы продолжить.');
    const source = query.feed === 'home' ? Prisma.sql`
      WITH pool AS (${pool}), coverage AS (
        SELECT "categoryId", count(DISTINCT "marketPointId") AS sellers FROM pool GROUP BY "categoryId"
      ), pairs AS (
        SELECT pool.*, coverage.sellers, md5(${seed} || ':product:' || id::text) AS shuffle,
          row_number() OVER (PARTITION BY "marketPointId", "categoryId"
            ORDER BY md5(${seed} || ':product:' || id::text), id) AS pair_rank
        FROM pool JOIN coverage USING ("categoryId")
      ), points AS (
        SELECT *, row_number() OVER (PARTITION BY "marketPointId"
          ORDER BY pair_rank, sellers, md5(${seed} || ':category:' || coalesce("marketPointId", 0)::text || ':' || "categoryId"::text), shuffle, id) AS point_rank FROM pairs
      ), categories AS (
        SELECT *, row_number() OVER (PARTITION BY "categoryId"
          ORDER BY point_rank, md5(${seed} || ':point:' || coalesce("marketPointId", 0)::text), shuffle, id) AS category_rank FROM points
      ), ranked AS (
        SELECT *, (row_number() OVER (ORDER BY point_rank, category_rank,
          md5(${seed} || ':point:' || coalesce("marketPointId", 0)::text), shuffle, id))::int AS position FROM categories
      )` : Prisma.sql`WITH ranked AS (${pool})`;
    const order = keys(query);
    const rows = await tx.$queryRaw<FeedRow[]>(Prisma.sql`${source}
        SELECT id, name, price, sort, "createdAt", "categoryId", "categorySort"
          ${query.feed === 'home' ? Prisma.sql`, position` : Prisma.empty}
        FROM ranked WHERE ${after(order, cursor?.tail)}
        ORDER BY ${Prisma.join(order.map(key => Prisma.sql`${column(key)} ${Prisma.raw(key.direction.toUpperCase())}`))}
        LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const cards = page.length ? await tx.product.findMany({ where: { id: { in: page.map(row => row.id) } }, select: productListSelect }) : [];
    const products = new Map(cards.map(product => [product.id, customerProduct(product)]));
    const tail = page.at(-1);
    const nextCursor = rows.length > query.limit && tail ? Buffer.from(JSON.stringify({
      version: 1, scope: feedScope(query), ceiling, seed, revision,
      tail: { ...tail, createdAt: tail.createdAt.toISOString() },
    } satisfies Cursor)).toString('base64url') : null;
    const total = counts[0]?.total ?? 0;
    return { items: page.flatMap(row => { const product = products.get(row.id); return product ? [product] : []; }),
      total, nextCursor, seed, page: 1, limit: query.limit, pages: Math.ceil(total / query.limit) };
  }, { isolationLevel: 'RepeatableRead' });
}
