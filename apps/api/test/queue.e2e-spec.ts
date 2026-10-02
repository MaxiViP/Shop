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
import { QueueService } from '../src/order/queue.js';
import { StaffService } from '../src/staff/staff.service.js';
import { NotificationService } from '../src/order/notification.service.js';
import { CustomerNotificationService } from '../src/telegram/customer-notification.service.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { SID } from '../src/auth/auth.service.js';
import { addDays, localInstant, moscowDay } from '../src/admin/shop-hours.js';

describe.skipIf(!process.env.DATABASE_URL)('order queue / local PostgreSQL', () => {
  const schema = `queue_test_${randomUUID().replaceAll('-', '')}`;
  const connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const telegram = { notifyNewOrder: vi.fn(async () => {}) };
  let db: PrismaClient;
  let app: INestApplication<Server>;
  let orders: OrderService;
  let queue: QueueService;
  let staff: StaffService;
  let productId: number;
  let customerA: number, customerB: number, sellerId: number;
  let ownerCookie: string, otherCookie: string, adminCookie: string;
  let created = false;
  const input = (requestId = randomUUID()) => ({
    type: 'PICKUP' as const, customerName: 'Покупатель', customerPhone: '+79990000777',
    checkoutRequestId: requestId, items: [{ productId, qty: 1 }],
  });
  const place = (userId: number, data: Parameters<OrderService['create']>[2] = input()) =>
    orders.create(userId, undefined, data);
  const tomorrow = () => localInstant(addDays(moscowDay(new Date()), 1), 12 * 60);
  async function session(role: 'USER' | 'SELLER' | 'ADMIN', phone: string) {
    const user = await db.user.create({ data: { role, phone } });
    const token = randomBytes(32).toString('hex');
    await db.session.create({ data: { userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000) } });
    return { id: user.id, cookie: `${SID}=${token}` };
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname))
      throw new Error('Local test database required');
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_STAFF_BOT_TOKEN', 'TELEGRAM_CUSTOMER_BOT_TOKEN',
      'TELEGRAM_ADMIN_CHAT_IDS', 'TELEGRAM_CUSTOMER_WEBHOOK_SECRET']) vi.stubEnv(key, '');
    vi.stubEnv('ADMIN_PHONE', '+79990000704');
    await connection.connect();
    if (!/^queue_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
    await connection.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true }))
      .filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    await connection.query('UPDATE "ShopHours" SET "openMinutes" = 0, "closeMinutes" = 1440');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    const typed = db as unknown as DbService;
    orders = new OrderService(typed, telegram as unknown as TelegramService);
    queue = new QueueService(typed);
    staff = new StaffService(typed, { dispatch: async () => {}, dispatchTelegram: async () => {} } as unknown as NotificationService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService).useValue(db)
      .overrideProvider(TelegramService).useValue(telegram)
      .compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    const a = await session('USER', '+79990000701');
    const b = await session('USER', '+79990000702');
    const s = await session('SELLER', '+79990000703');
    const admin = await session('ADMIN', '+79990000704');
    customerA = a.id; customerB = b.id; sellerId = s.id;
    ownerCookie = a.cookie; otherCookie = b.cookie; adminCookie = admin.cookie;
    const category = await db.category.create({ data: { name: 'Очередь', slug: 'queue-fixture' } });
    productId = (await db.product.create({ data: { categoryId: category.id, name: 'Яблоко',
      slug: 'queue-apple', unit: 'PIECE', price: 10000, priceQty: 1, min: 1, step: 1,
      portionQty: 1 } })).id;
  }, 60000);
  beforeEach(async () => {
    telegram.notifyNewOrder.mockClear();
    await db.orderStaffAudit.deleteMany();
    await db.order.deleteMany();
    await db.shopHoursException.deleteMany();
    await db.shopSettings.update({ where: { id: 1 }, data: {
      minDeliverySubtotal: 0, queueThreshold: 4, assemblyFallbackMinutes: 25, assemblyConcurrency: 1,
      slotIntervalMinutes: 30, slotCapacity: 1, peakModeEnabled: false,
      peakModeStart: null, peakModeEnd: null,
    } });
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (created && /^queue_test_[a-f0-9]{32}$/.test(schema))
      await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection.end();
    vi.unstubAllEnvs();
  }, 30000);

  async function peak() {
    await db.shopSettings.update({ where: { id: 1 }, data: { peakModeEnabled: true,
      peakModeStart: new Date(Date.now() - 60_000), peakModeEnd: new Date(Date.now() + 3600_000) } });
  }

  it('moves ASAP positions after cancellation and assembly, then uses recent median', async () => {
    const first = (await place(customerA)).order;
    const second = (await place(customerB)).order;
    const third = (await place(customerA)).order;
    expect((await queue.publicView(third.id)).position).toBe(3);
    expect((await queue.publicView(third.id)).wait?.min).toBeGreaterThan(0);
    await db.order.update({ where: { id: first.id }, data: { status: 'CANCELED' } });
    expect((await queue.publicView(third.id)).position).toBe(2);
    await staff.confirm(second.id, { userId: sellerId, role: 'SELLER' });
    await staff.startAssembly(second.id, { userId: sellerId, role: 'SELLER' });
    expect((await queue.publicView(third.id)).position).toBe(1);
    expect((await queue.publicView(second.id)).position).toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { id: second.id } })).assemblyStartedAt).not.toBeNull();
    for (const minutes of [10, 12, 15, 18, 30])
      await db.order.create({ data: { type: 'PICKUP', status: 'COMPLETED', customerName: 'История',
        customerPhone: '+79990000000', subtotal: 1,
        assemblyStartedAt: new Date(Date.now() - (minutes + 1) * 60_000),
        assemblyFinalizedAt: new Date(Date.now() - 60_000) } });
    expect((await queue.publicView()).estimatedAssemblyMinutes).toBe(15);
  });

  it('uses ADMIN configured parallel assembly for ETA without changing ordinal rank', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await place(customerA)).order.id);
    const sequential = await queue.publicView(ids[3]);
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', ownerCookie)
      .send({ assemblyConcurrency: 2 }).expect(403);
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', adminCookie)
      .send({ assemblyConcurrency: 0 }).expect(400);
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', adminCookie)
      .send({ assemblyConcurrency: 2 }).expect(200);
    const parallel = await queue.publicView(ids[3]);
    expect(parallel.assemblyConcurrency).toBe(2);
    expect(parallel.position).toBe(sequential.position);
    expect(parallel.wait!.max).toBeLessThan(sequential.wait!.max);
  });

  it('hides scheduled under threshold, honors peak window, and guards ADMIN settings', async () => {
    expect((await orders.offer()).showScheduledOffer).toBe(false);
    await place(customerA); await place(customerB);
    await db.shopSettings.update({ where: { id: 1 }, data: { queueThreshold: 2 } });
    expect((await orders.offer()).showScheduledOffer).toBe(true);
    await db.orderStaffAudit.deleteMany();
    await db.order.deleteMany();
    const now = new Date();
    const body = { peakModeEnabled: true,
      peakModeStart: new Date(now.getTime() - 60_000).toISOString(),
      peakModeEnd: new Date(now.getTime() + 60_000).toISOString() };
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', ownerCookie)
      .send(body).expect(403);
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', adminCookie)
      .send(body).expect(200);
    expect((await orders.offer()).showScheduledOffer).toBe(true);
    await db.shopSettings.update({ where: { id: 1 }, data: { peakModeEnd: new Date(now.getTime() - 1000) } });
    expect((await orders.offer()).showScheduledOffer).toBe(false);
  });

  it('checks opening hours, exceptions, slot interval and capacity on the server', async () => {
    await peak();
    const at = tomorrow();
    expect((await orders.offer()).slots.some(slot => slot.at === at.toISOString())).toBe(true);
    const saved = await place(customerA, { ...input(), fulfillmentMode: 'SCHEDULED', scheduledFor: at.toISOString() });
    expect(saved.order.scheduledFor).toEqual(at);
    expect((await orders.offer()).slots.some(slot => slot.at === at.toISOString())).toBe(false);
    expect((await queue.publicView(undefined, db as unknown as DbService, new Date(), true, true, true))
      .slots.find(slot => slot.at === at.toISOString())).toMatchObject({ reserved: 1, capacity: 1 });
    await expect(place(customerB, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: new Date(at.getTime() + 5 * 60_000).toISOString() })).rejects.toThrow();
    await db.shopHoursException.create({ data: { date: new Date(`${moscowDay(at)}T00:00:00.000Z`), closed: true } });
    expect((await orders.offer()).slots.some(slot => slot.at === at.toISOString())).toBe(false);
    await expect(place(customerB, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: new Date(at.getTime() + 30 * 60_000).toISOString() })).rejects.toThrow();
  });

  it('serializes simultaneous booking of the last slot and frees it after cancellation', async () => {
    await peak();
    const at = tomorrow();
    const selected = { fulfillmentMode: 'SCHEDULED' as const, scheduledFor: at.toISOString() };
    const attempts = await Promise.allSettled([
      place(customerA, { ...input(), ...selected }),
      place(customerB, { ...input(), ...selected }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const booked = await db.order.findFirstOrThrow({ where: { scheduledFor: at } });
    expect(await db.order.count({ where: { scheduledFor: at } })).toBe(1);
    await db.order.update({ where: { id: booked.id }, data: { status: 'CANCELED' } });
    await place(booked.userId === customerA ? customerB : customerA,
      { ...input(), ...selected });
    expect(await db.order.count({ where: { scheduledFor: at, status: { not: 'CANCELED' } } })).toBe(1);
  });

  it('does not offer a slot whose preparation would start before opening', async () => {
    await peak();
    const at = tomorrow();
    await db.shopHoursException.create({ data: {
      date: new Date(`${moscowDay(at)}T00:00:00.000Z`), closed: false,
      openMinutes: 12 * 60, closeMinutes: 14 * 60,
    } });
    const slots = (await orders.offer()).slots.map(slot => slot.at);
    expect(slots).not.toContain(at.toISOString());
    expect(slots).toContain(new Date(at.getTime() + 30 * 60_000).toISOString());
    expect(slots).toContain(new Date(at.getTime() + 90 * 60_000).toISOString());
    expect(slots).not.toContain(new Date(at.getTime() + 120 * 60_000).toISOString());
    await expect(place(customerA, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: at.toISOString() })).rejects.toThrow();
  });

  it('preserves booked slots across settings changes and blocks hours or capacity changes that break them', async () => {
    await peak();
    await db.shopSettings.update({ where: { id: 1 }, data: { slotCapacity: 2 } });
    const at = new Date(tomorrow().getTime() + 30 * 60_000);
    const booked = (await place(customerA, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: at.toISOString() })).order;
    await place(customerB, { ...input(), fulfillmentMode: 'SCHEDULED', scheduledFor: at.toISOString() });
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', adminCookie)
      .send({ slotCapacity: 1 }).expect(409);
    expect((await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } })).slotCapacity).toBe(2);
    const day = moscowDay(at);
    const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay() || 7;
    await request(app.getHttpServer()).patch(`/api/admin/schedule/weekly/${weekday}`)
      .set('Cookie', adminCookie).send({ enabled: false, openMinutes: 0, closeMinutes: 1440 }).expect(409);
    await request(app.getHttpServer()).post('/api/admin/schedule/exceptions')
      .set('Cookie', adminCookie).send({ date: day, closed: true,
        openMinutes: null, closeMinutes: null, note: null }).expect(409);
    expect(await db.shopHoursException.count({ where: { date: new Date(`${day}T00:00:00.000Z`) } })).toBe(0);
    await request(app.getHttpServer()).patch('/api/admin/settings').set('Cookie', adminCookie)
      .send({ slotIntervalMinutes: 60, peakModeEnabled: false }).expect(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: booked.id } })).scheduledFor).toEqual(at);
    await expect(place(customerA, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: new Date(at.getTime() + 30 * 60_000).toISOString() })).rejects.toThrow();
    await orders.schedule(booked.publicId, customerA, undefined, 'SCHEDULED',
      new Date(at.getTime() + 30 * 60_000).toISOString());
    expect((await db.order.findUniqueOrThrow({ where: { id: booked.id } })).scheduledFor)
      .toEqual(new Date(at.getTime() + 30 * 60_000));
  });

  it('does not overbook a released slot when restoring a canceled scheduled order', async () => {
    await peak();
    const at = tomorrow();
    const chosen = { fulfillmentMode: 'SCHEDULED' as const, scheduledFor: at.toISOString() };
    const first = (await place(customerA, { ...input(), ...chosen })).order;
    const actor = { userId: sellerId, role: 'SELLER' as const };
    await staff.cancel(first.id, sellerId, 'SELLER', 'Покупатель отменил', actor);
    const cancellation = await db.orderCancellation.findFirstOrThrow({ where: { orderId: first.id } });
    const second = (await place(customerB, { ...input(), ...chosen })).order;
    await expect(staff.restore(first.id, sellerId, 'SELLER', cancellation.id, actor)).rejects.toThrow();
    expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELED');
    await db.order.update({ where: { id: second.id }, data: { status: 'CANCELED' } });
    await staff.restore(first.id, sellerId, 'SELLER', cancellation.id, actor);
    expect(await db.order.count({ where: { scheduledFor: at, status: { not: 'CANCELED' } } })).toBe(1);
  });

  it('allows owner ASAP to scheduled, reschedule and back, but rejects foreign access', async () => {
    const saved = (await place(customerA)).order;
    await peak();
    const at = tomorrow();
    await expect(orders.schedule(saved.publicId, customerB, undefined, 'SCHEDULED', at.toISOString()))
      .rejects.toThrow();
    await orders.schedule(saved.publicId, customerA, undefined, 'SCHEDULED', at.toISOString());
    const later = new Date(at.getTime() + 30 * 60_000);
    await orders.schedule(saved.publicId, customerA, undefined, 'SCHEDULED', later.toISOString());
    await orders.schedule(saved.publicId, customerA, undefined, 'SCHEDULED', later.toISOString());
    expect((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).scheduledFor).toEqual(later);
    await orders.schedule(saved.publicId, customerA, undefined, 'ASAP');
    expect((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).scheduledFor).toBeNull();
    await db.order.update({ where: { id: saved.id }, data: { status: 'ASSEMBLING', assemblyStartedAt: new Date() } });
    await expect(orders.schedule(saved.publicId, customerA, undefined, 'SCHEDULED', at.toISOString()))
      .rejects.toThrow();
  });

  it('rejects schedule mutations after READY or PAID even if order status is otherwise mutable', async () => {
    await peak();
    const saved = (await place(customerA)).order;
    await db.order.update({ where: { id: saved.id }, data: { status: 'READY' } });
    await expect(orders.schedule(saved.publicId, customerA, undefined, 'SCHEDULED',
      tomorrow().toISOString())).rejects.toThrow();
    await db.order.update({ where: { id: saved.id }, data: { status: 'CONFIRMED' } });
    await db.orderPayment.create({ data: { orderId: saved.id, amount: 10000, status: 'PAID' } });
    await expect(orders.schedule(saved.publicId, customerA, undefined, 'SCHEDULED',
      tomorrow().toISOString())).rejects.toThrow();
  });

  it('keeps one order and one durable load notice on checkout retry', async () => {
    await peak();
    const body = input();
    const first = await place(customerA, body);
    const retry = await place(customerA, body);
    expect(retry.order.id).toBe(first.order.id);
    expect(await db.order.count()).toBe(1);
    expect(await db.orderNotification.count({ where: { type: 'QUEUE_DELAY' } })).toBe(1);
    expect(telegram.notifyNewOrder).toHaveBeenCalledTimes(1);
  });

  it('never returns another owner order for the same checkout request ID', async () => {
    const body = input();
    const first = await place(customerA, body);
    await expect(place(customerB, body)).rejects.toThrow('Повторное оформление недоступно');
    expect(await db.order.count()).toBe(1);
    expect(first.order.publicId).toBeDefined();
  });

  it('prepares a guest session before checkout and returns only public fields on retry', async () => {
    await peak();
    const prepared = await request(app.getHttpServer()).post('/api/orders/checkout-session')
      .expect(201);
    const cookie = (prepared.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const body = input();
    const first = await request(app.getHttpServer()).post('/api/orders')
      .set('Cookie', cookie).send(body).expect(201);
    const retry = await request(app.getHttpServer()).post('/api/orders')
      .set('Cookie', cookie).send(body).expect(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.body.userId).toBeUndefined();
    expect(retry.body.guestSessionId).toBeUndefined();
    expect(retry.body.checkoutRequestId).toBeUndefined();
    const at = tomorrow();
    const changed = await request(app.getHttpServer()).patch(`/api/orders/${first.body.publicId}/fulfillment`)
      .set('Cookie', cookie).send({ fulfillmentMode: 'SCHEDULED', scheduledFor: at.toISOString() }).expect(200);
    expect(changed.body).toEqual({ fulfillmentMode: 'SCHEDULED', scheduledFor: at.toISOString() });
    const stranger = await request(app.getHttpServer()).post('/api/orders/checkout-session').expect(201);
    const otherGuestCookie = (stranger.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    await request(app.getHttpServer()).patch(`/api/orders/${first.body.publicId}/fulfillment`)
      .set('Cookie', otherGuestCookie).send({ fulfillmentMode: 'ASAP' }).expect(404);
    expect(await db.order.count()).toBe(1);
    expect(await db.orderNotification.count({ where: { type: 'QUEUE_DELAY' } })).toBe(1);
  });

  it('keeps queue inputs authoritative and serves private owner queue only', async () => {
    const first = (await place(customerA)).order;
    await request(app.getHttpServer()).get(`/api/orders/${first.publicId}/queue`)
      .set('Cookie', otherCookie).expect(404);
    const own = await request(app.getHttpServer()).get(`/api/orders/${first.publicId}/queue`)
      .set('Cookie', ownerCookie).expect(200);
    expect(own.body.position).toBe(1);
    const created = await request(app.getHttpServer()).post('/api/orders')
      .send({ ...input(), queuePosition: 999, queueRank: 999, estimatedWait: 0, eta: 0,
        assemblyConcurrency: 99 }).expect(201);
    expect(created.body.queuePosition).toBeUndefined();
    expect(created.body.queueRank).toBeUndefined();
    expect(created.body.estimatedWait).toBeUndefined();
    expect(created.body.eta).toBeUndefined();
    expect(created.body.assemblyConcurrency).toBeUndefined();
    expect((await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } })).fulfillmentMode).toBe('ASAP');
  });

  it('ranks urgent scheduled first only at its lead time; started orders leave waiting rank', async () => {
    await peak();
    const asap = (await place(customerA)).order;
    const at = tomorrow();
    const scheduled = (await place(customerB, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: at.toISOString() })).order;
    let listed = await staff.list();
    expect(listed.find(row => row.id === asap.id)?.queueRank).toBe(1);
    expect(listed.find(row => row.id === scheduled.id)?.queueRank).toBeNull();
    await staff.confirm(scheduled.id, { userId: sellerId, role: 'SELLER' });
    await expect(staff.startAssembly(scheduled.id, { userId: sellerId, role: 'SELLER' }))
      .rejects.toThrow();
    await db.order.update({ where: { id: scheduled.id },
      data: { scheduledFor: new Date(Date.now() + 5 * 60_000) } });
    listed = await staff.list();
    expect(listed.find(row => row.id === scheduled.id)?.queueRank).toBe(1);
    await staff.startAssembly(scheduled.id, { userId: sellerId, role: 'SELLER' });
    expect((await staff.list()).find(row => row.id === scheduled.id)?.queueRank).toBeNull();
  });

  it('keeps committed order after uncertain Telegram delivery and never blind-retries it', async () => {
    await peak();
    await db.telegramIdentity.create({ data: { userId: customerA, telegramUserId: BigInt('7000000001'),
      customerBotStartedAt: new Date() } });
    const saved = (await place(customerA)).order;
    const provider = { available: true,
      send: vi.fn(async () => { throw new Error('provider unavailable'); }) };
    const notices = new NotificationService(db as unknown as DbService,
      { available: false, send: async () => {} },
      provider as unknown as CustomerNotificationService);
    await notices.dispatchTelegram(saved.id);
    expect(await db.order.count({ where: { id: saved.id } })).toBe(1);
    expect(await db.orderNotification.findFirstOrThrow({ where: { orderId: saved.id, type: 'QUEUE_DELAY' } }))
      .toMatchObject({ status: 'SENDING', attempts: 1 });
    await notices.dispatchTelegram(saved.id);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('creates one durable assembly-soon notice from the server sweep and resumes it after restart', async () => {
    await peak();
    await db.telegramIdentity.deleteMany({ where: { userId: customerA } });
    await db.telegramIdentity.create({ data: { userId: customerA, telegramUserId: BigInt('7000000002'),
      customerBotStartedAt: new Date() } });
    const saved = (await place(customerA, { ...input(), fulfillmentMode: 'SCHEDULED',
      scheduledFor: tomorrow().toISOString() })).order;
    await db.order.update({ where: { id: saved.id }, data: { status: 'CONFIRMED',
      createdAt: new Date(Date.now() - 3 * 60_000),
      scheduledFor: new Date(Date.now() + 5 * 60_000) } });
    const provider = { available: true, send: vi.fn(async () => 'sent' as const) };
    const first = new NotificationService(db as unknown as DbService,
      { available: false, send: async () => {} }, provider as unknown as CustomerNotificationService);
    vi.spyOn(first, 'dispatchTelegram').mockResolvedValue(undefined);
    await (first as unknown as { sweep(): Promise<void> }).sweep();
    expect(await db.orderNotification.count({ where: { orderId: saved.id, type: 'ASSEMBLY_SOON' } })).toBe(1);
    const resumed = new NotificationService(db as unknown as DbService,
      { available: false, send: async () => {} }, provider as unknown as CustomerNotificationService);
    await (resumed as unknown as { sweep(): Promise<void> }).sweep();
    await (resumed as unknown as { sweep(): Promise<void> }).sweep();
    expect(await db.orderNotification.findFirstOrThrow({ where: { orderId: saved.id,
      type: 'ASSEMBLY_SOON' } })).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(await db.orderNotification.count({ where: { orderId: saved.id, type: 'ASSEMBLY_SOON' } })).toBe(1);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
});
