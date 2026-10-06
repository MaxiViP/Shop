import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AppModule } from '../src/app.module.js';
import { OrderService } from '../src/order/order.service.js';
import { NotificationService } from '../src/order/notification.service.js';
import { inAppEvent, telegramEvent } from '../src/order/outbox.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { YandexService } from '../src/delivery/yandex.service.js';
import { DeliveryService } from '../src/delivery/delivery.service.js';
import { SID } from '../src/auth/auth.service.js';
import { GID } from '../src/common/guest.js';
import { addDays, localInstant, moscowDay } from '../src/admin/shop-hours.js';

interface Notice { id: number; orderId: number; kind: string; title: string; to: string }
interface Feed { scope: string | null; events: Notice[]; hasMore: boolean }

describe.skipIf(!process.env.DATABASE_URL)('storefront UX / local PostgreSQL', () => {
  const schema = `ux_events_test_${randomUUID().replaceAll('-', '')}`;
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>, orders: OrderService;
  let created = false;
  let owner: { id: number; cookie: string }, stranger: typeof owner, seller: typeof owner, admin: typeof owner;
  let apple: number, otherApple: number, pear: number;
  const calculate = vi.fn(async () => ({ price: 15000, currency: 'RUB', offerPayload: 'local-fixture' }));
  const call = (cookie: string) => {
    const http = request(app.getHttpServer());
    return {
      get: (path: string) => http.get('/api' + path).set('Cookie', cookie),
      post: (path: string, body: object = {}) => http.post('/api' + path).set('Cookie', cookie).send(body),
      patch: (path: string, body: object) => http.patch('/api' + path).set('Cookie', cookie).send(body),
    };
  };
  const feed = async (cookie: string, limit = 20): Promise<Feed> =>
    (await call(cookie).get(`/notifications?limit=${limit}`).expect(200)).body as Feed;
  const place = (userId: number | null = owner.id, guestToken?: string) => orders.create(userId, guestToken, {
    type: 'PICKUP', customerName: 'Покупатель', customerPhone: '+79990000901',
    items: [{ productId: apple, qty: 1 }], checkoutRequestId: randomUUID(),
  });
  const chat = (id: number, cookie = seller.cookie, requestId = randomUUID()) =>
    call(cookie).post(`/staff/orders/${id}/messages`, { text: 'Актуальный прилавок', requestId });
  async function session(role: 'USER' | 'SELLER' | 'ADMIN', phone: string) {
    const user = await db.user.create({ data: { role, phone } });
    const token = randomBytes(32).toString('hex');
    await db.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000) } });
    return { id: user.id, cookie: `${SID}=${token}` };
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local test database required');
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_STAFF_BOT_TOKEN', 'TELEGRAM_CUSTOMER_BOT_TOKEN',
      'TELEGRAM_ADMIN_CHAT_IDS', 'TELEGRAM_CUSTOMER_WEBHOOK_SECRET']) vi.stubEnv(key, '');
    vi.stubEnv('ADMIN_PHONE', '+79990000904');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^ux_events_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
    await connection.query('UPDATE "ShopHours" SET "openMinutes" = 0, "closeMinutes" = 1440');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DbService).useValue(db)
      .overrideProvider(TelegramService).useValue({ notifyNewOrder: async () => {} })
      .overrideProvider(NotificationService).useValue({ available: false, dispatch: async () => {},
        dispatchTelegram: async () => {}, dispatchStaffChat: async () => {}, dispatchStaffPrice: async () => {} })
      .overrideProvider(YandexService).useValue({ isAvailable: () => true, isSyncAvailable: () => false, calculate })
      .compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true })); await app.init();
    orders = app.get(OrderService);
    owner = await session('USER', '+79990000901'); stranger = await session('USER', '+79990000902');
    seller = await session('SELLER', '+79990000903'); admin = await session('ADMIN', '+79990000904');
    const fruit = await db.category.create({ data: { name: 'Фрукты', slug: 'fruit-ux' } });
    const market = await db.category.create({ data: { name: 'Яблоки — название категории', slug: 'market-ux' } });
    const product = { unit: 'PIECE' as const, price: 10000, priceQty: 1, min: 1, step: 1, portionQty: 1 };
    apple = (await db.product.create({ data: { ...product, categoryId: fruit.id, name: 'Яблоки', slug: 'apple-ux' } })).id;
    otherApple = (await db.product.create({ data: { ...product, categoryId: market.id, name: 'Красные яблоки', slug: 'other-apple-ux' } })).id;
    pear = (await db.product.create({ data: { ...product, categoryId: market.id, name: 'Груша', slug: 'pear-ux' } })).id;
    await db.product.create({ data: { ...product, categoryId: fruit.id, name: 'Яблоки скрытые', slug: 'inactive-ux', active: false } });
  }, 60000);
  beforeEach(async () => {
    await db.orderStaffAudit.deleteMany(); await db.order.deleteMany(); await db.address.deleteMany();
    await db.user.update({ where: { id: owner.id }, data: { role: 'USER' } });
    await db.shopSettings.update({ where: { id: 1 }, data: { minDeliverySubtotal: 0, queueThreshold: 1, slotCapacity: 3 } });
    calculate.mockClear();
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^ux_events_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end(); vi.unstubAllEnvs();
  }, 30000);

  it('searches products globally, prioritizes the current category and never treats category names as products', async () => {
    const result = await call('').get('/products?category=fruit-ux&q=ЯБЛОКИ').expect(200);
    expect(result.body.items.map((item: { id: number }) => item.id)).toEqual([apple, otherApple]);
    expect(result.body.currentCategory.name).toBe('Фрукты');
    expect(result.body.groupTotals).toEqual({ current: 1, others: 1 });
    const ids = result.body.items.map((item: { id: number }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.body.items[0].price).toBe(11000);
    const elsewhere = await call('').get('/products?category=fruit-ux&q=груша').expect(200);
    expect(elsewhere.body.items.map((item: { id: number }) => item.id)).toEqual([pear]);
    expect(elsewhere.body.groupTotals).toEqual({ current: 0, others: 1 });
    const onlyCurrent = await call('').get('/products?category=fruit-ux&q=Яблоки&ids=' + apple).expect(200);
    expect(onlyCurrent.body.groupTotals).toEqual({ current: 1, others: 0 });
    const global = await call('').get('/products?q=яблоки').expect(200);
    expect(new Set(global.body.items.map((item: { id: number }) => item.id))).toEqual(new Set([apple, otherApple]));
    expect((await call('').get('/products?q=название%20категории').expect(200)).body.items).toEqual([]);
    expect((await call('').get('/products?category=fruit-ux&q=несуществующий').expect(200)).body.total).toBe(0);
    const page = await call('').get('/products?category=fruit-ux&q=яблоки&limit=1&page=1').expect(200);
    expect(page.body.items).toHaveLength(2); expect(page.body.pages).toBe(1);
    expect((await call('').get('/products?category=fruit-ux&q=яблоки&limit=1&page=2').expect(200)).body.items).toEqual([]);
    expect((await call('').get('/products?category=fruit-ux').expect(200)).body.items.map((item: { id: number }) => item.id)).toEqual([apple]);
  });

  it('saves optional building text, snapshots checkout and supplies every order view and delivery input', async () => {
    const input = { label: 'Дом', city: 'Москва', street: 'Рыночная', house: '7', flat: '3', buildingPart: ' к. 2 ' };
    const address = await call(owner.cookie).post('/addresses', input).expect(201);
    expect(address.body.buildingPart).toBe('к. 2');
    const cart = (await call(owner.cookie).get('/cart').expect(200)).body;
    const changed = (await call(owner.cookie).post('/cart/change', { kind: 'set', revision: cart.revision, productId: apple, qty: 1 }).expect(201)).body;
    const checkout = await call(owner.cookie).post('/cart/checkout', { revision: changed.revision, type: 'DELIVERY',
      customerName: 'Покупатель', customerPhone: '+79990000901', address: { ...input, buildingPart: address.body.buildingPart } }).expect(201);
    const order = checkout.body.order as { id: number; publicId: string };
    await call(owner.cookie).patch('/addresses/' + address.body.id, { buildingPart: 'корпус 3' }).expect(200);
    expect((await call(owner.cookie).get('/addresses').expect(200)).body[0].buildingPart).toBe('корпус 3');
    await call(stranger.cookie).patch('/addresses/' + address.body.id, { buildingPart: 'чужой' }).expect(404);
    for (const [cookie, path] of [[owner.cookie, '/orders/' + order.publicId], [seller.cookie, '/staff/orders/' + order.id],
      [admin.cookie, '/admin/orders/' + order.id]] as const)
      expect((await call(cookie).get(path).expect(200)).body.buildingPart).toBe('к. 2');
    await call(owner.cookie).patch('/addresses/' + address.body.id, { buildingPart: '' }).expect(200);
    await call(owner.cookie).patch('/addresses/' + address.body.id, { buildingPart: 'x'.repeat(51) }).expect(400);
    const legacy = await call(owner.cookie).post('/addresses', { label: 'Другой', city: 'Москва', street: 'Старая', house: '1' }).expect(201);
    expect(legacy.body.buildingPart).toBeNull();
    await db.order.update({ where: { id: order.id }, data: { status: 'READY', finalSubtotal: 10000 } });
    await db.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'PICKED', actualQty: 1, actualTotal: 10000 } });
    await app.get(DeliveryService).quote(order.id);
    expect(calculate).toHaveBeenCalledWith(expect.objectContaining({ address: expect.objectContaining({
      fullname: 'Москва, Рыночная, д. 7, к. 2', building: '7, к. 2', flat: '3',
    }) }));
    expect((await place()).order.id).toBeGreaterThan(order.id);
  });

  it('delivers new chat events to the counterpart without Telegram and preserves chat unread on toast seen', async () => {
    const order = (await place()).order;
    const key = randomUUID();
    const first = await chat(order.id, seller.cookie, key).expect(201);
    await chat(order.id, seller.cookie, key).expect(201);
    const events = await feed(owner.cookie);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ kind: 'CHAT_MESSAGE', title: `Новое сообщение по заказу №${order.id}`,
      to: `/order/${order.publicId}?chatMessage=${first.body.id}#order-chat` });
    expect((await feed(seller.cookie)).events).toEqual([]);
    expect((await feed(stranger.cookie)).events).toEqual([]);
    const id = events.events[0]!.id;
    await call(stranger.cookie).post('/notifications/seen', { ids: [id] }).expect(404);
    for (let i = 0; i < 2; i++) await call(owner.cookie).post('/notifications/seen', { ids: [id, id] }).expect(201);
    expect((await feed(owner.cookie)).events).toEqual([]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).customerUnread).toBe(1);
    const response = await call(owner.cookie).post(`/orders/${order.publicId}/messages`, { text: 'Выбираю это', requestId: randomUUID() }).expect(201);
    expect((await feed(owner.cookie)).events).toEqual([]);
    for (const staff of [seller, admin]) expect((await feed(staff.cookie)).events[0]?.to)
      .toBe(`/staff/orders/${order.id}?chatMessage=${response.body.id}#order-chat`);
  });

  it('persists lifecycle, price and issue events with one toast per mutation and no financial/admin payload', async () => {
    const order = (await place()).order;
    await call(seller.cookie).post(`/staff/orders/${order.id}/confirm`).expect(201);
    await call(seller.cookie).post(`/staff/orders/${order.id}/assembly/start`).expect(201);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const price = { sellerPrice: 10500, requestId: randomUUID() };
    for (let i = 0; i < 2; i++) await call(seller.cookie).patch(`/staff/orders/${order.id}/items/${item.id}/price`, price).expect(200);
    await call(seller.cookie).patch(`/staff/orders/${order.id}/items/${item.id}`, { status: 'PICKED', actualQty: 1 }).expect(200);
    await call(seller.cookie).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    const events = (await feed(owner.cookie)).events;
    expect(events.map(event => event.kind)).toEqual(['ORDER_STATUS_CHANGED', 'ASSEMBLY_STARTED', 'ITEM_PRICE_CHANGED', 'ORDER_UPDATED', 'ORDER_READY']);
    expect(events[2]?.title).toContain('110 ₽ → 115,50 ₽');
    expect(events[2]?.to).toBe(`/order/${order.publicId}#order-items`);
    expect(events[4]?.to).toBe(`/order/${order.publicId}#order-payment`);
    expect(JSON.stringify(events)).not.toMatch(/actorId|basePrice|settlement|token|phone|cookie/);
    const missing = (await place()).order;
    await call(seller.cookie).post(`/staff/orders/${missing.id}/confirm`).expect(201);
    await call(seller.cookie).post(`/staff/orders/${missing.id}/assembly/start`).expect(201);
    const missingItem = await db.orderItem.findFirstOrThrow({ where: { orderId: missing.id } });
    await call(seller.cookie).patch(`/staff/orders/${missing.id}/items/${missingItem.id}`, { status: 'MISSING' }).expect(200);
    expect((await feed(owner.cookie)).events.find(event => event.kind === 'ORDER_ISSUE')?.to).toBe(`/order/${missing.publicId}#order-issues`);
    const issue = await db.orderIssue.findUniqueOrThrow({ where: { orderItemId: missingItem.id } });
    await call(owner.cookie).post(`/orders/${missing.publicId}/issues/${issue.id}/decision`, {
      version: issue.version, action: 'REMOVE_ITEM',
    }).expect(201);
    expect((await feed(owner.cookie)).events.filter(event => event.orderId === missing.id && event.kind === 'ORDER_ISSUE')).toEqual([]);
  });

  it('suppresses own staff/customer actions and only notifies staff about a customer schedule change', async () => {
    const order = (await place()).order;
    await db.user.update({ where: { id: owner.id }, data: { role: 'SELLER' } });
    await chat(order.id, owner.cookie).expect(201);
    expect((await feed(owner.cookie)).events).toEqual([]);
    const at = localInstant(addDays(moscowDay(new Date()), 1), 12 * 60).toISOString();
    for (let i = 0; i < 2; i++) await orders.schedule(order.publicId, owner.id, undefined, 'SCHEDULED', at);
    expect((await feed(owner.cookie)).events).toEqual([]);
    expect((await feed(seller.cookie)).events.filter(event => event.kind === 'SCHEDULE_CHANGED')).toHaveLength(1);
    expect((await feed(seller.cookie)).events[0]?.title).toContain('12:00');
    await orders.schedule(order.publicId, owner.id, undefined, 'ASAP');
    expect((await feed(seller.cookie)).events.filter(event => event.kind === 'SCHEDULE_CHANGED')).toHaveLength(2);
  });

  it('does not toast READY to a staff member who finished their own order', async () => {
    const order = (await place()).order;
    await db.user.update({ where: { id: owner.id }, data: { role: 'SELLER' } });
    await call(owner.cookie).post(`/staff/orders/${order.id}/confirm`).expect(201);
    await call(owner.cookie).post(`/staff/orders/${order.id}/assembly/start`).expect(201);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    await call(owner.cookie).patch(`/staff/orders/${order.id}/items/${item.id}`, { status: 'PICKED', actualQty: 1 }).expect(200);
    await call(owner.cookie).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    expect((await feed(owner.cookie)).events).toEqual([]);
  });

  it('does not deliver a stale READY toast after the seller reopens assembly', async () => {
    const order = (await place()).order;
    await call(seller.cookie).post(`/staff/orders/${order.id}/confirm`).expect(201);
    await call(seller.cookie).post(`/staff/orders/${order.id}/assembly/start`).expect(201);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    await call(seller.cookie).patch(`/staff/orders/${order.id}/items/${item.id}`, { status: 'PICKED', actualQty: 1 }).expect(200);
    await call(seller.cookie).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    await call(seller.cookie).post(`/staff/orders/${order.id}/assembly/reopen`).expect(201);
    expect((await feed(owner.cookie)).events.filter(event => event.kind === 'ORDER_READY')).toEqual([]);
    expect(await db.orderNotification.findFirst({ where: { orderId: order.id, channel: 'IN_APP', type: 'PAYMENT_READY' } }))
      .toMatchObject({ status: 'CANCELED', seenAt: null });
  });

  it('supports guest ownership, seen state and expiry without exposing another session', async () => {
    const first = await place(null), other = await place(null);
    const cookie = `${GID}=${first.guestToken!}`;
    await chat(first.order.id).expect(201);
    expect((await feed(`${GID}=${other.guestToken!}`)).events).toEqual([]);
    expect((await feed('')).events).toEqual([]);
    const pending = await feed(cookie);
    expect(pending.scope).toMatch(/^g:/);
    expect(pending.events[0]?.orderId).toBe(first.order.id);
    await call(cookie).post('/notifications/seen', { ids: [pending.events[0]!.id] }).expect(201);
    expect((await feed(cookie)).events).toEqual([]);
    await chat(first.order.id).expect(201);
    await db.guestSession.updateMany({ where: { orders: { some: { id: first.order.id } } }, data: { expiresAt: new Date(0) } });
    expect((await feed(cookie)).scope).toBeNull();
  });

  it('catches up across reloads and late commits using per-event seen state rather than a lossy maximum ID', async () => {
    const order = (await place()).order;
    let ready!: () => void, release!: () => void, lowId = 0;
    const inserted = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const late = db.$transaction(async tx => {
      lowId = (await inAppEvent(tx, { orderId: order.id, type: 'ORDER_CONFIRMED', dedupeKey: 'late-commit' })).id;
      ready(); await gate;
    });
    await inserted;
    try {
      const high = await inAppEvent(db, { orderId: order.id, type: 'ASSEMBLY_STARTED', dedupeKey: 'early-commit' });
      const visible = await feed(owner.cookie, 1);
      expect(visible.events.map(event => event.id)).toEqual([high.id]);
      await call(owner.cookie).post('/notifications/seen', { ids: [high.id] }).expect(201);
    } finally { release(); await late; }
    expect((await feed(owner.cookie)).events.map(event => event.id)).toEqual([lowId]);
    await expect(db.$transaction(async tx => {
      await inAppEvent(tx, { orderId: order.id, type: 'PAYMENT_READY', dedupeKey: 'rollback' }); throw new Error('rollback fixture');
    })).rejects.toThrow('rollback fixture');
    expect(await db.orderNotification.count({ where: { dedupeKey: 'rollback' } })).toBe(0);
    await telegramEvent(db, { orderId: order.id, type: 'QUEUE_DELAY', dedupeKey: 'quiet-queue' });
    expect(await db.orderNotification.count({ where: { channel: 'IN_APP', dedupeKey: 'quiet-queue' } })).toBe(0);
    await inAppEvent(db, { orderId: order.id, type: 'ASSEMBLY_STARTED', dedupeKey: 'early-commit' });
    expect((await feed(owner.cookie)).events.map(event => event.id)).toEqual([lowId]);
  });
});
