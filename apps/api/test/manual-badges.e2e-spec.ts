import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AdminGuard } from '../src/auth/admin.guard.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { HitsCtrl } from '../src/admin/hits.ctrl.js';
import { HitsService } from '../src/admin/hits.service.js';
import { SeasonsCtrl } from '../src/admin/seasons.ctrl.js';
import { SeasonsService } from '../src/admin/seasons.service.js';
import { ProductCtrl } from '../src/product/product.ctrl.js';
import { ProductService } from '../src/product/product.service.js';

type Cards = { items: { id: number; isHit: boolean; isSeasonal: boolean }[]; nextCursor: string | null; total: number };
const schema = `manual_badges_test_${randomUUID().replaceAll('-', '')}`;
function client() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` }, { schema }),
    log: [{ emit: 'event', level: 'query' }] });
}

describe.skipIf(!process.env.DATABASE_URL)('Manual hits and market presets / isolated PostgreSQL', () => {
  let connection: pg.Client, db: ReturnType<typeof client>, app: INestApplication<Server>;
  let created = false, actorId: number, categoryId: number, automaticId: number, manualId: number, offId: number, legacyId: number, legacyTemplateId: number;
  let legacyBefore: Record<string, unknown>;
  let legacyAfterMigration: Record<string, unknown>;
  const queries: string[] = [];
  let recordQueries = false;
  const admin = `${SID}=ADMIN`;
  const http = () => request(app.getHttpServer());
  const patch = (id: number, body: object) => http().patch(`/api/admin/products/${id}`).set('Cookie', admin).send(body);
  const cards = async (query: object = {}) => (await http().get('/api/products').query(query).expect(200)).body as Cards;
  async function application() {
    const module = await Test.createTestingModule({
      controllers: [AdminProductsCtrl, HitsCtrl, SeasonsCtrl, ProductCtrl],
      providers: [AdminProductsService, ImagesService, HitsService, SeasonsService, ProductService, AdminGuard,
        { provide: DbService, useValue: db },
        { provide: AuthService, useValue: { me: async (role: string) => ['USER', 'SELLER', 'ADMIN'].includes(role)
          ? { id: actorId, role, phone: '+79990000001' } : null } }],
    }).compile();
    const result = module.createNestApplication<INestApplication<Server>>({ logger: false });
    result.use(cookieParser()); result.setGlobalPrefix('api');
    result.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await result.init();
    await vi.waitFor(async () => expect((await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } })).hitLastCalculatedAt).not.toBeNull());
    return result;
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/korzina_e2e_unicode')
      throw new Error('Only the explicitly isolated test database is allowed; never local shop');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL }); await connection.connect();
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const migration of migrations) {
      if (migration.name === '20261010160000_manual_hits_season_presets') {
        legacyTemplateId = (await connection.query<{ id: number }>(`INSERT INTO "SeasonTemplate" (name,"startMonth","endMonth",active,"updatedAt") VALUES ('Редис',4,8,false,NOW()) RETURNING id`)).rows[0]!.id;
        const category = (await connection.query<{ id: number }>(`INSERT INTO "Category" (name,slug,"updatedAt") VALUES ('До миграции','legacy',NOW()) RETURNING id`)).rows[0]!.id;
        legacyId = (await connection.query<{ id: number }>(`INSERT INTO "Product" (name,slug,price,unit,"portionQty","categoryId","seasonalMode","seasonTemplateId","updatedAt") VALUES ('Товар до миграции','legacy-product',10000,'PIECE',1,$1,'AUTO',$2,NOW()) RETURNING id`, [category, legacyTemplateId])).rows[0]!.id;
        legacyBefore = (await connection.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(p) AS row FROM "Product" p WHERE id=$1', [legacyId])).rows[0]!.row;
      }
      await connection.query(await readFile(join('prisma/migrations', migration.name, 'migration.sql'), 'utf8'));
    }
    legacyAfterMigration = (await connection.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(p) row FROM "Product" p WHERE id=$1', [legacyId])).rows[0]!.row;
    db = client(); db.$on('query', event => { if (recordQueries) queries.push(event.query); });
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    actorId = (await db.user.create({ data: { role: 'ADMIN', phone: '+79990000001' } })).id;
    categoryId = (await db.category.create({ data: { slug: 'fruits', name: 'Фрукты' } })).id;
    const other = (await db.category.create({ data: { slug: 'other', name: 'Другая категория' } })).id;
    const product = (slug: string, categoryId: number) => db.product.create({ data: { name: `Яблоки ${slug}`, slug, categoryId, price: 10000,
      unit: 'PIECE', priceQty: 1, min: 1, step: 1, portionQty: 1 } });
    automaticId = (await product('automatic', categoryId)).id;
    manualId = (await product('manual', categoryId)).id;
    offId = (await product('off', other)).id;
    app = await application();
  }, 60_000);
  beforeEach(async () => {
    await db.product.updateMany({ where: { id: { in: [automaticId, manualId, offId] } }, data: { hitMode: 'AUTO', isHit: false,
      seasonalMode: 'OFF', isSeasonal: false, seasonTemplateId: null, hitOrders: 0, hitSoldUnits: 0, hitRank: null } });
    await db.order.deleteMany();
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^manual_badges_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end(); vi.unstubAllEnvs();
  });

  it('adds AUTO to existing products without changing previous values or template links', async () => {
    expect(legacyAfterMigration).toEqual({ ...legacyBefore, hitMode: 'AUTO' });
    expect((await db.product.findUniqueOrThrow({ where: { id: legacyId } })).seasonTemplateId).toBe(legacyTemplateId);
  });
  it.each(['missing', 'USER', 'SELLER'])('protects both badge mutations and preset filling from %s', async role => {
    await http().post('/api/admin/hits/assign').set('Cookie', `${SID}=${role}`).send({ ids: [manualId], hitMode: 'MANUAL' }).expect(403);
    await http().post('/api/admin/seasons/presets').set('Cookie', `${SID}=${role}`).expect(403);
  });
  it('manually enables/disables and returns to AUTO without changing statistics', async () => {
    const initial = await db.product.findUniqueOrThrow({ where: { id: manualId } });
    for (const [hitMode, expected] of [['MANUAL', true], ['OFF', false], ['AUTO', false]] as const) {
      const response = await patch(manualId, { hitMode }).expect(200);
      expect(response.body).toMatchObject({ hitMode, isHit: expected, autoHit: false });
      const current = await db.product.findUniqueOrThrow({ where: { id: manualId } });
      expect([current.isHit, current.hitOrders, current.hitSoldUnits, current.hitRank]).toEqual([initial.isHit, initial.hitOrders, initial.hitSoldUnits, initial.hitRank]);
      expect((await cards({ q: 'Яблоки' })).items.find(row => row.id === manualId)?.isHit).toBe(expected);
    }
    await patch(manualId, { isHit: true, hitOrders: 999 }).expect(400);
  });
  it('survives real ranking recalculation and an API application restart', async () => {
    await http().post('/api/admin/hits/assign').set('Cookie', admin).send({ ids: [manualId], hitMode: 'MANUAL' }).expect(201);
    await patch(offId, { hitMode: 'OFF' }).expect(200);
    for (const productId of [automaticId, offId]) {
      const product = await db.product.findUniqueOrThrow({ where: { id: productId } });
      for (let index = 0; index < 3; index++) await db.order.create({ data: { type: 'PICKUP', status: 'COMPLETED', completedAt: new Date(Date.now() - 60_000),
        customerName: 'Продажа', customerPhone: '+79990000099', subtotal: 10000, total: 10000,
        items: { create: { productId, productName: product.name, productSlug: product.slug, unit: 'PIECE', price: 10000, priceQty: 1, qty: 1, actualQty: 1,
          status: 'PICKED', total: 10000, actualTotal: 10000 } }, payment: { create: { amount: 10000, status: 'PAID' } } } });
    }
    await http().post('/api/admin/hits/recalculate').set('Cookie', admin).expect(201);
    const manual = await db.product.findUniqueOrThrow({ where: { id: manualId } });
    expect(manual).toMatchObject({ hitMode: 'MANUAL', isHit: false, hitOrders: 0 });
    const disabled = await db.product.findUniqueOrThrow({ where: { id: offId } });
    expect(disabled).toMatchObject({ hitMode: 'OFF', isHit: true, hitOrders: 3 });
    expect((await cards({ tag: 'hit' })).items.map(row => row.id)).toEqual(expect.arrayContaining([automaticId, manualId]));
    expect((await cards({ tag: 'hit' })).items.some(row => row.id === offId)).toBe(false);
    await app.close(); app = await application();
    expect((await cards()).items.find(row => row.id === manualId)?.isHit).toBe(true);
    expect((await db.product.findUniqueOrThrow({ where: { id: offId } })).hitMode).toBe('OFF');
    await app.get(HitsService).recalculate(false, undefined, new Date(Date.now() + 86400_000));
    expect((await db.product.findUniqueOrThrow({ where: { id: manualId } })).hitMode).toBe('MANUAL');
  });
  it('keeps hit and season modes independent in catalogue, search and homepage feeds', async () => {
    for (const [hitMode, seasonalMode, expectedHit, expectedSeason] of [
      ['MANUAL', 'OFF', true, false], ['OFF', 'MANUAL', false, true], ['MANUAL', 'MANUAL', true, true],
    ] as const) {
      await patch(manualId, { hitMode, seasonalMode }).expect(200);
      for (const query of [{}, { q: 'Яблоки' }, { q: 'Яблоки', category: 'fruits' }, { feed: 'catalog' }, { feed: 'home' }])
        expect((await cards(query)).items.find(row => row.id === manualId)).toMatchObject({ isHit: expectedHit, isSeasonal: expectedSeason });
    }
  });
  it('bulk updates only selected modes and lists manual and automatic states separately', async () => {
    const untouched = await db.product.findUniqueOrThrow({ where: { id: offId } });
    await http().post('/api/admin/hits/assign').set('Cookie', admin).send({ ids: [automaticId, manualId], hitMode: 'MANUAL' }).expect(201);
    expect(await db.product.findUniqueOrThrow({ where: { id: offId } })).toEqual(untouched);
    const response = await http().get('/api/admin/hits').set('Cookie', admin).query({ hitMode: 'MANUAL' }).expect(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.every((row: { autoHit: boolean; isHit: boolean }) => !row.autoHit && row.isHit)).toBe(true);
    await http().post('/api/admin/hits/assign').set('Cookie', admin).send({ ids: [manualId, 2147483647], hitMode: 'OFF' }).expect(409);
    expect((await db.product.findUniqueOrThrow({ where: { id: manualId } })).hitMode).toBe('MANUAL');
  });
  it('fills presets concurrently without duplicates and retains pre-existing edits and links', async () => {
    const before = await db.seasonTemplate.findUniqueOrThrow({ where: { id: legacyTemplateId } });
    const results = await Promise.all([http().post('/api/admin/seasons/presets').set('Cookie', admin), http().post('/api/admin/seasons/presets').set('Cookie', admin)]);
    expect(results.every(result => result.status === 201)).toBe(true);
    expect(await db.seasonTemplate.count()).toBe(36);
    expect(await db.seasonTemplate.findUniqueOrThrow({ where: { id: legacyTemplateId } })).toEqual({ ...before, key: 'moscow-radish' });
    expect((await db.product.findUniqueOrThrow({ where: { id: legacyId } })).seasonTemplateId).toBe(legacyTemplateId);
    await http().patch(`/api/admin/seasons/${legacyTemplateId}`).set('Cookie', admin).send({ name: 'Авторский редис', description: 'Урожай конкретного региона', startMonth: 3, endMonth: 9, active: false, group: 'BERRIES' }).expect(200);
    const edited = await db.seasonTemplate.findUniqueOrThrow({ where: { id: legacyTemplateId } });
    await http().post('/api/admin/seasons/presets').set('Cookie', admin).expect(201);
    expect(await db.seasonTemplate.findUniqueOrThrow({ where: { id: legacyTemplateId } })).toEqual(edited);
    expect(await db.seasonTemplate.count()).toBe(36);
    const linked = await http().get('/api/admin/products').set('Cookie', admin).query({ seasonTemplateId: legacyTemplateId }).expect(200);
    expect(linked.body.items.map((row: { id: number }) => row.id)).toEqual([legacyId]);
    expect(await db.product.count({ where: { seasonTemplateId: { not: null } } })).toBe(1);
  });
  it('keeps cursor paging and relation query counts bounded as badge cards increase', async () => {
    await db.product.createMany({ data: Array.from({ length: 24 }, (_, index) => ({ name: `Карточка ${index}`, slug: `card-${index}`, categoryId,
      price: 10000, unit: 'PIECE' as const, priceQty: 1, min: 1, step: 1, portionQty: 1, hitMode: 'MANUAL' as const })) });
    queries.length = 0; recordQueries = true;
    let page: Cards;
    try { page = await cards({ feed: 'catalog', tag: 'hit', limit: 24 }); }
    finally { recordQueries = false; }
    expect(page.items).toHaveLength(24); expect(page.items.every(row => row.isHit)).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(12);
    expect(page.nextCursor).toBeNull();
    const seen = new Set<number>(); let cursor: string | undefined;
    do {
      const current = await cards({ feed: 'home', tag: 'hit', limit: 5, ...(cursor ? { cursor } : {}) });
      for (const item of current.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
      cursor = current.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(24);
  });
});
