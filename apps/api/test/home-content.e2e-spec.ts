import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import sharp from 'sharp';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AdminGuard } from '../src/auth/admin.guard.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { AdminSlidesCtrl, PublicSlidesCtrl } from '../src/admin/slides.ctrl.js';
import { SlidesService } from '../src/admin/slides.service.js';
import type { SlideInput } from '../src/admin/slides.schema.js';
import { SettingsCtrl, PublicSettingsCtrl } from '../src/admin/settings.ctrl.js';
import { SettingsService } from '../src/admin/settings.service.js';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { productUploadRoot } from '../src/common/image.js';
import { ProductCtrl } from '../src/product/product.ctrl.js';
import { ProductService } from '../src/product/product.service.js';
import { OrderCtrl } from '../src/order/order.ctrl.js';
import { OrderService } from '../src/order/order.service.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { SeasonsCtrl } from '../src/admin/seasons.ctrl.js';
import { SeasonsService } from '../src/admin/seasons.service.js';
import { HitsCtrl } from '../src/admin/hits.ctrl.js';
import { HitsService } from '../src/admin/hits.service.js';
import { seasonalSql, seasonalWhere } from '../src/product/badges.js';
import { goodsLine } from '../src/order/pricing.js';
import type { OrderStatus, Unit } from '../src/db/gen/client.js';

type Slides = { slides: { id: number; title: string; to: string }[]; validUntil: string };
type Cards = { items: { id: number; price: number; isSeasonal: boolean; isHit: boolean }[]; nextCursor: string | null };
const base: SlideInput = { type: 'PERMANENT', content: 'CUSTOM', title: 'Продукты с рынка', text: 'Выбирайте продукты в каталоге.',
  eyebrow: null, image: null, position: 'center', buttonLabel: 'Каталог', to: '/catalog',
  active: true, published: true, priority: false, sortOrder: 0, startsAt: null, endsAt: null };

describe.skipIf(!process.env.DATABASE_URL)('Home content, migration and checkout / isolated local PostgreSQL', () => {
  const schema = `home_content_test_${randomUUID().replaceAll('-', '')}`;
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>;
  let created = false, historicalOrder: number, productId: number, categoryId: number;
  let seedSql: string;
  const uploads: string[] = [];
  const http = () => request(app.getHttpServer());
  const admin = `${SID}=ADMIN`;
  const slides = async () => (await http().get('/api/home/slides').expect(200)).body as Slides;
  const createSlide = async (changes: Partial<SlideInput> = {}) =>
    (await http().post('/api/admin/home-slides').set('Cookie', admin).send({ ...base, ...changes }).expect(201)).body as { id: number };
  const patch = (id: number, changes: Partial<SlideInput>) => http().patch(`/api/admin/home-slides/${id}`).set('Cookie', admin).send(changes);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only a local database is allowed');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL }); await connection.connect();
    if (!/^home_content_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const sql = await readFile(join(root, entry.name, 'migration.sql'), 'utf8');
      if (entry.name === '20261010120000_home_content') {
        // Representative existing data before the new additive migration.
        const result = await connection.query<{ id: number }>(`INSERT INTO "Order" (type, "customerName", "customerPhone", subtotal,
          "deliveryPrice", total, "finalSubtotal", "finalTotal", "updatedAt")
          VALUES ('DELIVERY', 'Historical test', '+79990000099', 123456, 43765, 167221, 120001, 163766, NOW()) RETURNING id`);
        historicalOrder = result.rows[0]!.id;
        seedSql = sql.slice(sql.indexOf('INSERT INTO "HomeSlide"'));
      }
      await connection.query(sql);
    }
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` }, { schema }) });
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    const actor = await db.user.create({ data: { role: 'ADMIN', phone: '+79990000001' } });
    const module = await Test.createTestingModule({
      controllers: [AdminSlidesCtrl, PublicSlidesCtrl, SettingsCtrl, PublicSettingsCtrl, AdminProductsCtrl, ProductCtrl, OrderCtrl, SeasonsCtrl, HitsCtrl],
      providers: [SlidesService, SettingsService, AdminProductsService, ImagesService, ProductService, OrderService, AdminGuard, SeasonsService, HitsService,
        { provide: DbService, useValue: db }, { provide: TelegramService, useValue: { notifyNewOrder: vi.fn() } },
        { provide: AuthService, useValue: { me: async (token: string) => ['USER', 'SELLER', 'ADMIN'].includes(token)
          ? { id: actor.id, role: token, phone: actor.phone } : null } }],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true })); await app.init();
    categoryId = (await db.category.create({ data: { slug: 'home-test-fruits', name: 'Фрукты' } })).id;
    productId = (await db.product.create({ data: { name: 'Яблоки', slug: 'home-test-apples', categoryId, price: 10_000,
      unit: 'PIECE', priceQty: 1, min: 1, step: 1, portionQty: 1 } })).id;
    await db.shopSettings.update({ where: { id: 1 }, data: { minDeliverySubtotal: 0 } });
    await db.shopHours.updateMany({ data: { enabled: true, openMinutes: 0, closeMinutes: 1440 } });
  }, 60_000);

  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    for (const path of uploads) await unlink(path);
    if (created && /^home_content_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end(); vi.unstubAllEnvs();
  });

  it('preserves historical money and all four legacy slides; initialization is repeatable', async () => {
    expect(await db.order.findUnique({ where: { id: historicalOrder } })).toMatchObject({ subtotal: 123456, deliveryPrice: 43765,
      total: 167221, finalSubtotal: 120001, finalTotal: 163766, freeDeliveryApplied: false, freeDeliveryThresholdSnapshot: null });
    const legacy = await db.homeSlide.findMany({ where: { published: true }, orderBy: { sortOrder: 'asc' } });
    expect(legacy).toHaveLength(4);
    expect(legacy[0]).toMatchObject({ key: 'legacy-hero-0', image: '/images/hero/hero-0.webp',
      title: 'Не просто доставка.\nАутентичный поход на рынок — без потери времени.' });
    expect(legacy[0]?.text).toContain('в прямом чате заказа.');
    await db.homeSlide.update({ where: { id: legacy[0]!.id }, data: { text: 'Administrator edit' } });
    await connection.query(seedSql);
    expect(await db.homeSlide.count()).toBe(9);
    expect((await db.homeSlide.findUnique({ where: { id: legacy[0]!.id } }))?.text).toBe('Administrator edit');
    // Only fixtures inside this generated test schema are cleared.
    await db.homeSlide.deleteMany();
  });

  it.each(['missing', 'USER', 'SELLER'])('protects every administrative operation from %s', async role => {
    const cookie = `${SID}=${role}`;
    await http().get('/api/admin/home-slides').set('Cookie', cookie).expect(403);
    await http().post('/api/admin/home-slides').set('Cookie', cookie).send(base).expect(403);
    await http().patch('/api/admin/home-slides/1').set('Cookie', cookie).send({ active: false }).expect(403);
    await http().delete('/api/admin/home-slides/1').set('Cookie', cookie).expect(403);
    await http().post('/api/admin/home-slides/1/copy').set('Cookie', cookie).expect(403);
    await http().post('/api/admin/home-slides/1/image').set('Cookie', cookie).expect(403);
    await http().post('/api/admin/home-slides/reorder').set('Cookie', cookie).send({ ids: [1] }).expect(403);
    await http().post('/api/admin/home-slides/preview').set('Cookie', cookie).send(base).expect(403);
    await http().get('/api/admin/seasons').set('Cookie', cookie).expect(403);
    await http().post('/api/admin/seasons').set('Cookie', cookie).send({}).expect(403);
    await http().patch('/api/admin/seasons/1').set('Cookie', cookie).send({ active: false }).expect(403);
    await http().post('/api/admin/seasons/assign').set('Cookie', cookie).send({}).expect(403);
    await http().get('/api/admin/hits').set('Cookie', cookie).expect(403);
    await http().patch('/api/admin/hits/settings').set('Cookie', cookie).send({}).expect(403);
    await http().post('/api/admin/hits/recalculate').set('Cookie', cookie).expect(403);
  });

  it('creates, edits, copies, reorders, disables and deletes slides; only one published priority survives concurrency', async () => {
    const a = await createSlide({ title: 'Первый', sortOrder: 5 });
    const b = await createSlide({ title: 'Второй', sortOrder: 1 });
    expect((await slides()).slides.map(slide => slide.id)).toEqual([b.id, a.id]);
    await http().post('/api/admin/home-slides/reorder').set('Cookie', admin).send({ ids: [a.id, b.id] }).expect(201);
    await patch(a.id, { title: 'Изменённый' }).expect(200);
    expect((await slides()).slides[0]?.title).toBe('Изменённый');
    await Promise.all([patch(a.id, { priority: true }).expect(200), patch(b.id, { priority: true }).expect(200)]);
    expect(await db.homeSlide.count({ where: { published: true, priority: true } })).toBe(1);
    const first = (await slides()).slides[0]!;
    await patch(first.id, { active: false }).expect(200);
    expect((await slides()).slides).toHaveLength(1);
    await patch(first.id, { active: true }).expect(200);
    expect((await slides()).slides[0]?.id).toBe(first.id);
    const copied = (await http().post(`/api/admin/home-slides/${a.id}/copy`).set('Cookie', admin).expect(201)).body as { id: number };
    expect(await db.homeSlide.findUnique({ where: { id: copied.id } })).toMatchObject({ published: false, priority: false });
    await http().delete(`/api/admin/home-slides/${copied.id}`).set('Cookie', admin).expect(200);
    await http().post('/api/admin/home-slides/reorder').set('Cookie', admin).send({ ids: [a.id] }).expect(409);
    await http().post('/api/admin/home-slides').set('Cookie', admin).send({ ...base, to: 'javascript:alert(1)' }).expect(400);
    await patch(a.id, { title: 'x'.repeat(141) }).expect(400);
    await patch(a.id, { type: 'TEMPORARY' }).expect(400);
    await db.homeSlide.deleteMany();
    expect((await slides()).slides).toEqual([]);
  });

  it('edits one complete slide without changing any other slide', async () => {
    const first = await createSlide({ title: 'Первый слайд', image: '/images/hero/hero-0.webp' });
    const second = await createSlide({ title: 'Второй слайд', sortOrder: 1 });
    const other = await db.homeSlide.findUniqueOrThrow({ where: { id: second.id } });
    const changes = { title: 'Новый заголовок', text: 'Новое описание', image: '/images/hero/hero-2.webp',
      buttonLabel: 'Условия доставки', to: '/delivery' };
    await patch(first.id, changes).expect(200);
    expect(await db.homeSlide.findUniqueOrThrow({ where: { id: second.id } })).toEqual(other);
    const response = await http().get('/api/home/slides').expect(200);
    expect(response.body.slides).toEqual([
      expect.objectContaining({ id: first.id, ...changes }),
      expect.objectContaining({ id: second.id, title: 'Второй слайд' }),
    ]);
    await db.homeSlide.deleteMany();
  });

  it('uses half-open schedules, excludes drafts and refreshes the priority fallback', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await createSlide({ type: 'TEMPORARY', priority: true, startsAt: future,
      endsAt: new Date(Date.now() + 7200_000).toISOString() });
    const ordinary = await createSlide({ title: 'Обычный' });
    await createSlide({ published: false });
    expect((await slides()).slides.map(slide => slide.id)).toEqual([ordinary.id]);
    await patch(scheduled.id, { startsAt: new Date(Date.now() - 1000).toISOString() }).expect(200);
    expect((await slides()).slides[0]?.id).toBe(scheduled.id);
    await patch(scheduled.id, { endsAt: new Date(Date.now() - 1).toISOString(), startsAt: null }).expect(200);
    expect((await slides()).slides.map(slide => slide.id)).toEqual([ordinary.id]);
    const list = await http().get('/api/admin/home-slides').set('Cookie', admin).expect(200);
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduled.id, status: 'ENDED' })]));
    await db.homeSlide.deleteMany();
  });

  it('resolves real settings and real product collections, including expiry and empty selections', async () => {
    const delivery = await createSlide({ content: 'FREE_DELIVERY', title: 'Бесплатная доставка от {threshold}' });
    const seasonal = await createSlide({ content: 'SEASONAL' });
    const hit = await createSlide({ content: 'HITS' });
    expect((await slides()).slides).toEqual([]);
    await http().patch('/api/admin/settings').set('Cookie', admin).send({ freeDeliveryEnabled: true }).expect(400);
    await http().patch('/api/admin/settings').set('Cookie', admin).send({ freeDeliveryEnabled: true, freeDeliveryThreshold: 22_000 }).expect(200);
    await http().patch(`/api/admin/products/${productId}`).set('Cookie', admin).send({ isHit: true }).expect(400);
    await http().patch(`/api/admin/products/${productId}`).set('Cookie', admin).send({ seasonalMode: 'MANUAL' }).expect(200);
    // Public rendering of a computed badge; the ranking algorithm is exercised below with real completed sales.
    await db.product.update({ where: { id: productId }, data: { isHit: true } });
    const current = await slides();
    expect(current.slides.map(slide => slide.id)).toEqual([delivery.id, seasonal.id, hit.id]);
    expect(current.slides[0]?.title).toContain('220');
    expect(current.slides[1]?.to).toBe('/catalog?tag=seasonal');
    const cards = (await http().get('/api/products').query({ feed: 'catalog', tag: 'seasonal' }).expect(200)).body as Cards;
    expect(cards.items).toEqual([expect.objectContaining({ id: productId, isSeasonal: true, isHit: true, price: 11_000 })]);
    await http().patch(`/api/admin/products/${productId}`).set('Cookie', admin).send({ seasonalMode: 'OFF' }).expect(200);
    expect((await slides()).slides.some(slide => slide.id === seasonal.id)).toBe(false);
    await http().patch(`/api/admin/products/${productId}`).set('Cookie', admin).send({ seasonalStartsAt: '2026-12-01T00:00:00.000Z', seasonalEndsAt: '2026-11-01T00:00:00.000Z' }).expect(400);
    await http().patch('/api/admin/settings').set('Cookie', admin).send({ freeDeliveryEnabled: false }).expect(200);
    expect((await slides()).slides.some(slide => slide.id === delivery.id)).toBe(false);
    const response = await http().get('/api/home/slides').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    await db.homeSlide.deleteMany();
  });

  it('validates images, stages optimized WebP, preserves the old image, and applies the staged image on save', async () => {
    const record = await createSlide({ image: '/images/hero/hero-0.webp' });
    await http().post(`/api/admin/home-slides/${record.id}/image`).set('Cookie', admin).attach('file', Buffer.from('<svg/>'), { filename: 'bad.svg', contentType: 'image/svg+xml' }).expect(400);
    const buffer = await sharp({ create: { width: 2200, height: 600, channels: 3, background: '#15803d' } }).png().toBuffer();
    const uploaded = await http().post(`/api/admin/home-slides/${record.id}/image`).set('Cookie', admin).attach('file', buffer, { filename: 'hero.png', contentType: 'image/png' }).expect(201);
    const image = (uploaded.body as { image: string }).image;
    const name = /^\/uploads\/products\/hero\/([a-f0-9-]{36}\.webp)$/.exec(image)?.[1];
    expect(name).toBeTruthy();
    const path = resolve(productUploadRoot, 'hero', name!); uploads.push(path);
    expect((await sharp(await readFile(path)).metadata()).width).toBe(1920);
    expect((await db.homeSlide.findUnique({ where: { id: record.id } }))?.image).toBe('/images/hero/hero-0.webp');
    await patch(record.id, { image }).expect(200);
    await http().delete(`/api/admin/home-slides/${record.id}`).set('Cookie', admin).expect(200);
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  });

  it('rechecks checkout, never trusts client delivery costs, and retains old orders after settings change', async () => {
    await db.shopSettings.update({ where: { id: 1 }, data: { freeDeliveryEnabled: true, freeDeliveryThreshold: 22_000 } });
    const quote = (qty: number) => http().post('/api/orders/quote').send({ items: [{ productId, qty }], deliveryPrice: 0 });
    expect((await quote(1).expect(201)).body.delivery).toMatchObject({ remaining: 11_000, eligible: false, price: null });
    expect((await quote(2).expect(201)).body.delivery).toMatchObject({ remaining: 0, eligible: true, price: 0, total: 22_000 });
    expect((await quote(3).expect(201)).body.delivery.eligible).toBe(true);
    const body = { type: 'DELIVERY', customerName: 'Иван', customerPhone: '+79990000099',
      address: { city: 'Москва', street: 'Барклая', house: '10' }, items: [{ productId, qty: 2 }], deliveryPrice: 1, total: 1 };
    const order = (await http().post('/api/orders').send(body).expect(201)).body as { id: number };
    expect(await db.order.findUnique({ where: { id: order.id } })).toMatchObject({ subtotal: 22_000, total: 22_000, deliveryPrice: 0,
      freeDeliveryApplied: true, freeDeliveryThresholdSnapshot: 22_000 });
    await db.shopSettings.update({ where: { id: 1 }, data: { freeDeliveryThreshold: 33_000 } });
    const changed = (await http().post('/api/orders').send(body).expect(201)).body as { id: number };
    expect(await db.order.findUnique({ where: { id: changed.id } })).toMatchObject({ deliveryPrice: null, total: null, freeDeliveryApplied: false });
    expect(await db.order.findUnique({ where: { id: order.id } })).toMatchObject({ deliveryPrice: 0, freeDeliveryThresholdSnapshot: 22_000 });
    const pickup = (await http().post('/api/orders').send({ ...body, type: 'PICKUP', address: undefined }).expect(201)).body as { id: number };
    expect(await db.order.findUnique({ where: { id: pickup.id } })).toMatchObject({ deliveryPrice: 0, total: 22_000, freeDeliveryApplied: false, freeDeliveryThresholdSnapshot: null });
    await db.shopSettings.update({ where: { id: 1 }, data: { freeDeliveryEnabled: false } });
    expect((await quote(4).expect(201)).body.delivery).toMatchObject({ enabled: false, eligible: false, price: null });
  });

  it('protects ADMIN mutations against foreign origins and forbids public mutations', async () => {
    for (const path of ['/api/admin/home-slides', '/api/admin/seasons', '/api/admin/hits/recalculate'])
      await http().post(path).set('Cookie', admin).set('Origin', 'https://foreign.example').send(base).expect(403);
    await http().post('/api/home/slides').send(base).expect(404);
    await http().post('/api/seasons/assign').send({ ids: [productId] }).expect(404);
    await http().post('/api/hits/recalculate').expect(404);
  });

  it('creates and edits calendar templates, assigns only selected products and repeats across Moscow New Year', async () => {
    const winter = (await http().post('/api/admin/seasons').set('Cookie', admin).send({ name: 'Зимний сезон', startMonth: 11, endMonth: 2, active: true }).expect(201)).body as { id: number };
    await http().post('/api/admin/seasons').set('Cookie', admin).send({ name: 'Ошибка', startMonth: 0, endMonth: 13, active: true }).expect(400);
    const other = await db.product.create({ data: { name: 'Груши', slug: 'home-test-pears', categoryId, price: 10_000,
      unit: 'PIECE', priceQty: 1, min: 1, step: 1, portionQty: 1 } });
    const assign = (ids: number[], seasonalMode = 'AUTO', seasonTemplateId: number | null = winter.id) =>
      http().post('/api/admin/seasons/assign').set('Cookie', admin).send({ ids, seasonalMode, seasonTemplateId });
    await assign([productId], 'AUTO', null).expect(400);
    await assign([productId, productId]).expect(400);
    await assign([productId, 2147483647]).expect(409);
    expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).seasonalMode).toBe('OFF');
    await assign([productId]).expect(201);
    expect((await db.product.findUniqueOrThrow({ where: { id: other.id } })).seasonalMode).toBe('OFF');
    for (const [at, active] of [
      ['2026-10-31T20:59:59.999Z', false], ['2026-10-31T21:00:00.000Z', true],
      ['2026-12-31T21:00:00.000Z', true], ['2027-02-28T20:59:59.999Z', true],
      ['2027-02-28T21:00:00.000Z', false], ['2027-10-31T21:00:00.000Z', true],
    ] as const) {
      const now = new Date(at);
      expect(await db.product.count({ where: { id: productId, ...seasonalWhere(now) } })).toBe(active ? 1 : 0);
      const rows = await db.$queryRaw<{ id: number }[]>`SELECT p.id FROM "Product" p WHERE p.id = ${productId} AND ${seasonalSql(now)}`;
      expect(rows).toHaveLength(active ? 1 : 0);
    }
    await assign([productId, other.id]).expect(201);
    await http().patch(`/api/admin/seasons/${winter.id}`).set('Cookie', admin).send({ name: 'Весь год', startMonth: 1, endMonth: 12 }).expect(200);
    const catalog = (await http().get('/api/products').query({ feed: 'catalog', tag: 'seasonal' }).expect(200)).body as Cards;
    expect(catalog.items.map(item => item.id).toSorted()).toEqual([productId, other.id].toSorted());
    await http().patch(`/api/admin/seasons/${winter.id}`).set('Cookie', admin).send({ active: false }).expect(200);
    expect(((await http().get('/api/products').query({ feed: 'catalog', tag: 'seasonal' }).expect(200)).body as Cards).items).toEqual([]);
    await assign([productId], 'MANUAL', null).expect(201);
    expect(((await http().get('/api/products').query({ feed: 'catalog', tag: 'seasonal' }).expect(200)).body as Cards).items.map(item => item.id)).toEqual([productId]);
    await assign([productId], 'OFF', null).expect(201);
  });

  it('ranks actual completed sales, excludes returns/cancellations, resolves ties and updates each Moscow day', async () => {
    const now = new Date();
    const category = await db.category.create({ data: { slug: 'rating-fruits', name: 'Рейтинг фруктов' } });
    const second = await db.category.create({ data: { slug: 'rating-vegetables', name: 'Рейтинг овощей' } });
    const products = [];
    for (let index = 0; index < 13; index++) products.push(await db.product.create({ data: {
      name: `Рейтинг ${index}`, slug: `rating-${index}`, categoryId: index < 10 ? category.id : second.id,
      price: 100, unit: index === 10 ? 'GRAM' : 'PIECE', priceQty: index === 10 ? 1000 : 1,
      min: 1, step: 1, portionQty: 1,
    } }));
    const sale = async (product: { id: number; name: string; slug: string; unit: Unit; priceQty: number }, qty: number,
      options: { status?: OrderStatus; age?: number; duplicate?: boolean; returned?: boolean; paymentCanceled?: boolean; missing?: boolean } = {}) => {
      const total = goodsLine(110, qty, product.priceQty);
      const item = { productId: product.id, productName: product.name, productSlug: product.slug, price: 110, priceQty: product.priceQty,
        unit: product.unit, status: options.missing ? 'MISSING' as const : 'PICKED' as const, qty, actualQty: options.missing ? 0 : qty,
        total, actualTotal: options.missing ? 0 : total };
      return db.order.create({ data: { type: options.returned ? 'DELIVERY' : 'PICKUP', status: options.status ?? 'COMPLETED',
        completedAt: new Date(now.getTime() - (options.age ?? 1000)), customerName: 'Продажа', customerPhone: '+79990000099',
        subtotal: total, finalSubtotal: total, total, finalTotal: total, deliveryPrice: 0,
        items: { create: options.duplicate ? [item, item] : [item] },
        payment: { create: { amount: total, status: options.paymentCanceled ? 'CANCELED' : 'PAID' } },
        ...(options.returned ? { delivery: { create: { provider: 'YANDEX', status: 'DELIVERED', providerStatus: 'returned_finish', publicToken: randomUUID() } } } : {}),
      } });
    };
    for (let order = 0; order < 4; order++) await sale(products[0]!, 1, { duplicate: order === 0 });
    for (let order = 0; order < 3; order++) {
      await sale(products[1]!, 5); await sale(products[2]!, 5); await sale(products[10]!, 1001);
    }
    for (let order = 0; order < 2; order++) await sale(products[3]!, 100);
    for (const status of ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'CANCELED'] as const)
      await sale(products[3]!, 100, { status });
    await sale(products[3]!, 100, { age: 31 * 86400_000 });
    await sale(products[3]!, 100, { age: -86400_000 });
    await sale(products[3]!, 100, { returned: true });
    await sale(products[3]!, 100, { paymentCanceled: true });
    await sale(products[3]!, 100, { missing: true });
    await http().post('/api/admin/hits/recalculate').set('Cookie', admin).expect(201);
    const ranking = await db.product.findMany({ where: { categoryId: category.id }, orderBy: { hitRank: 'asc' } });
    expect(ranking.slice(0, 4).map(product => [product.id, product.hitOrders, product.hitSoldUnits.toString(), product.isHit]))
      .toEqual([[products[0]!.id, 4, '5', true], [products[1]!.id, 3, '15', true], [products[2]!.id, 3, '15', false], [products[3]!.id, 2, '200', false]]);
    expect((await db.product.findUniqueOrThrow({ where: { id: products[10]!.id } })).hitSoldUnits.toString()).toBe('3.003');
    expect((await db.product.findUniqueOrThrow({ where: { id: products[10]!.id } })).isHit).toBe(true);
    const listing = await http().get('/api/admin/hits').set('Cookie', admin).query({ category: category.id }).expect(200);
    expect(listing.body.settings).toMatchObject({ periodDays: 30, minOrders: 3, shareBps: 1500 });
    expect(listing.body.items[0]).toMatchObject({ id: products[0]!.id, hitOrders: 4 });
    const hits = new HitsService(db as unknown as DbService);
    expect(await hits.recalculate(false)).toEqual({ skipped: true });
    await http().patch('/api/admin/hits/settings').set('Cookie', admin).send({ periodDays: 30, minOrders: 5, shareBps: 1500 }).expect(200);
    expect(await db.product.count({ where: { isHit: true } })).toBe(0);
    await http().patch('/api/admin/hits/settings').set('Cookie', admin).send({ periodDays: 0, minOrders: 0, shareBps: 10001 }).expect(400);
    await http().patch('/api/admin/hits/settings').set('Cookie', admin).send({ periodDays: 30, minOrders: 3, shareBps: 1500 }).expect(200);
    const concurrent = await Promise.all([http().post('/api/admin/hits/recalculate').set('Cookie', admin), http().post('/api/admin/hits/recalculate').set('Cookie', admin)]);
    expect(concurrent.every(response => [201, 409].includes(response.status))).toBe(true);
    expect(concurrent.some(response => response.status === 201)).toBe(true);
    await db.product.update({ where: { id: products[0]!.id }, data: { active: false } });
    await hits.recalculate(true, undefined, new Date(now.getTime() + 86400_000));
    expect((await db.product.findUniqueOrThrow({ where: { id: products[0]!.id } })).isHit).toBe(false);
    await db.order.updateMany({ where: { items: { some: { productId: { in: products.map(product => product.id) } } } }, data: { status: 'CANCELED' } });
    await hits.recalculate(true);
    expect(await db.product.count({ where: { isHit: true } })).toBe(0);
  });
});
