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
import { PrismaClient, type UserRole } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AppModule } from '../src/app.module.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { NotificationService } from '../src/order/notification.service.js';
import { OrderService } from '../src/order/order.service.js';
import { StaffService } from '../src/staff/staff.service.js';
import { orderSchema } from '../src/order/schema.js';
import { SID } from '../src/auth/auth.service.js';
type Buyer = { id: number; cookie: string };
type Created = Awaited<ReturnType<OrderService['create']>>['order'];
type Promo = { id: number; code: string };
describe.skipIf(!process.env.DATABASE_URL)('personal compensation / isolated PostgreSQL', () => {
  const schema = 'promo_test_' + randomUUID().replaceAll('-', '');
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>, staff: StaffService;
  let created = false, admin: Buyer, seller: Buyer, productId: number, gramId: number, legacyId: number;
  let sequence = 1000;
  const http = () => request(app.getHttpServer());
  async function account(role: UserRole = 'USER'): Promise<Buyer> {
    const phone = '+7999' + String(++sequence).padStart(7, '0');
    const user = await db.user.create({ data: { role, phone, name: 'Promo fixture' } });
    const token = randomBytes(32).toString('hex');
    await db.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000) } });
    return { id: user.id, cookie: SID + '=' + token };
  }
  const issue = async (user: Buyer, changes: Record<string, unknown> = {}): Promise<Promo> =>
    (await http().post('/api/admin/promo-codes').set('Cookie', admin.cookie).send({
      userId: user.id, title: 'Компенсация', type: 'FIXED', amount: 5000,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: 'private-delay-reason', ...changes,
    }).expect(201)).body as Promo;
  const basket = async (user: Buyer) => (await http().get('/api/cart').set('Cookie', user.cookie).expect(200)).body as {
    revision: string; token: string; subtotal: number; goodsTotal: number;
    promo: { id: number; eligible: boolean; discount: number; reason: string | null } | null;
    promoCodes: { id: number; eligible: boolean; reason: string | null }[];
    delivery: { eligible: boolean; remaining: number; price: number | null };
  };
  async function change(user: Buyer, body: object, expected = 201) {
    return http().post('/api/cart/change').set('Cookie', user.cookie).send({ revision: (await basket(user)).revision, ...body }).expect(expected);
  }
  async function fill(user: Buyer, qty = 2, id = productId) { await change(user, { kind: 'set', productId: id, qty }); }
  function checkout(user: Buyer, revision: string, changes: Record<string, unknown> = {}) {
    return http().post('/api/cart/checkout').set('Cookie', user.cookie).send({
      revision, checkoutRequestId: randomUUID(), type: 'PICKUP', customerName: 'Покупатель',
      customerPhone: '+79990000999', ...changes,
    });
  }
  async function place(user: Buyer, changes: Record<string, unknown> = {}): Promise<Created> {
    return (await checkout(user, (await basket(user)).revision, changes).expect(201)).body.order as Created;
  }
  async function assemble(orderId: number, qty = 2) {
    const actor = { userId: seller.id, role: 'SELLER' as const };
    await staff.confirm(orderId, actor); await staff.startAssembly(orderId, actor);
    const items = await db.orderItem.findMany({ where: { orderId } });
    await staff.item(orderId, items[0]!.id, { status: 'PICKED', actualQty: qty }, seller.id, actor);
    return staff.finishAssembly(orderId, actor);
  }
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Only a local test database is allowed');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL }); await connection.connect();
    if (!/^promo_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await connection.query('SET search_path TO "' + schema + '"');
    const migrations = resolve('prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20261010140000_personal_promos') {
        legacyId = (await connection.query<{ id: number }>('INSERT INTO "Order" (type,"customerName","customerPhone",subtotal,"deliveryPrice",total,"finalSubtotal","finalTotal","updatedAt") VALUES (\'PICKUP\',\'Legacy\',\'+79990000998\',100,0,100,100,100,NOW()) RETURNING id')).rows[0]!.id;
      }
      await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
    }
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: '-c search_path=' + schema }, { schema }) });
    admin = await account('ADMIN'); seller = await account('SELLER');
    const administrator = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    vi.stubEnv('ADMIN_PHONE', administrator.phone!);
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DbService).useValue(db)
      .overrideProvider(TelegramService).useValue({ notifyNewOrder: async () => {} })
      .overrideProvider(NotificationService).useValue({ dispatch: async () => {}, dispatchTelegram: async () => {},
        dispatchStaffChat: async () => {}, dispatchStaffPrice: async () => {}, available: false }).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true })); await app.init();
    staff = app.get(StaffService);
    const category = await db.category.create({ data: { name: 'Promo fixtures', slug: 'promo-fixtures' } });
    productId = (await db.product.create({ data: { name: 'Яблоко', slug: 'promo-apple', categoryId: category.id,
      unit: 'PIECE', price: 10000, priceQty: 1, min: 1, step: 1, portionQty: 1 } })).id;
    gramId = (await db.product.create({ data: { name: 'Весовой товар', slug: 'promo-grams', categoryId: category.id,
      unit: 'GRAM', price: 10000, priceQty: 1000, min: 100, step: 100, portionQty: 1000 } })).id;
    await db.shopHours.updateMany({ data: { enabled: true, openMinutes: 0, closeMinutes: 1440 } });
  }, 60000);
  beforeEach(async () => {
    await db.shopSettings.update({ where: { id: 1 }, data: { minDeliverySubtotal: 0, freeDeliveryEnabled: false, freeDeliveryThreshold: null } });
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^promo_test_[a-f0-9]{32}$/.test(schema)) await connection.query('DROP SCHEMA "' + schema + '" CASCADE');
    await connection?.end(); vi.unstubAllEnvs();
  }, 30000);

  it('preserves legacy order money and initializes the discount to zero', async () => {
    expect(await db.order.findUnique({ where: { id: legacyId } })).toMatchObject({ subtotal: 100, total: 100, finalSubtotal: 100, finalTotal: 100, promoDiscount: 0, promoCodeId: null });
  });
  it('issues several codes, searches the existing buyer, and keeps administration metadata private', async () => {
    const user = await account(), other = await account();
    const a = await issue(user), b = await issue(user, { type: 'PERCENT', amount: null, percentBps: 1000, maxDiscount: 5000 });
    await issue(other);
    const list = await http().get('/api/promo-codes').set('Cookie', user.cookie).expect(200);
    expect(list.body.map((code: { id: number }) => code.id).sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(list.body)).not.toMatch(/private-delay-reason|sourceOrderId|issuedById|"reason"/);
    expect(list.headers['cache-control']).toBe('private, no-store');
    const adminList = await http().get('/api/admin/promo-codes').set('Cookie', admin.cookie).query({ userId: user.id, status: 'AVAILABLE' }).expect(200);
    expect(adminList.body.total).toBe(2); expect(adminList.body.items[0].reason).toBe('private-delay-reason');
    const users = await http().get('/api/admin/users').set('Cookie', admin.cookie).query({ role: 'USER', search: 'Promo fixture' }).expect(200);
    expect(users.body.items.some((value: { id: number }) => value.id === user.id)).toBe(true);
  });
  it('switches the selected code, caps the percentage and removes it without spending either code', async () => {
    const user = await account(), fixed = await issue(user), percent = await issue(user, { type: 'PERCENT', amount: null, percentBps: 5000, maxDiscount: 3000 });
    await fill(user);
    await change(user, { kind: 'promo', promoCodeId: percent.id });
    expect(await basket(user)).toMatchObject({ subtotal: 22000, goodsTotal: 19000, promo: { discount: 3000 } });
    await change(user, { kind: 'promo', promoCodeId: fixed.id });
    expect(await basket(user)).toMatchObject({ goodsTotal: 17000, promo: { id: fixed.id } });
    await change(user, { kind: 'promo', promoCodeId: null });
    expect(await basket(user)).toMatchObject({ goodsTotal: 22000, promo: null });
    expect(await db.promoCode.count({ where: { userId: user.id, status: 'AVAILABLE' } })).toBe(2);
  });
  it('rechecks the minimum after changing quantities and keeps invalid checkout atomic', async () => {
    const user = await account(), promo = await issue(user, { minSubtotal: 22000 });
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    await fill(user, 1);
    expect(await basket(user)).toMatchObject({ promo: { eligible: false, discount: 0, reason: 'Сумма товаров меньше минимальной' } });
    await checkout(user, (await basket(user)).revision).expect(409);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).status).toBe('AVAILABLE');
    await fill(user, 2); expect((await basket(user)).promo?.eligible).toBe(true);
  });
  it('rejects expired, revoked, foreign and guest code selection', async () => {
    const user = await account(), other = await account();
    const expired = await issue(user), revoked = await issue(user), foreign = await issue(other);
    await db.promoCode.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    await http().post('/api/admin/promo-codes/' + revoked.id + '/revoke').set('Cookie', admin.cookie).expect(201);
    await fill(user);
    await change(user, { kind: 'promo', promoCodeId: expired.id }, 409);
    await change(user, { kind: 'promo', promoCodeId: revoked.id }, 409);
    await change(user, { kind: 'promo', promoCodeId: foreign.id }, 400);
    await http().post('/api/orders/quote').send({ items: [{ productId, qty: 1 }], promoCodeId: foreign.id }).expect(400);
    const list = await http().get('/api/promo-codes').set('Cookie', user.cookie).expect(200);
    expect(list.body.find((p: { id: number }) => p.id === expired.id).status).toBe('EXPIRED');
    expect((await http().get('/api/admin/promo-codes').set('Cookie', admin.cookie).query({ userId: user.id, status: 'EXPIRED' }).expect(200)).body.total).toBe(1);
  });
  it('uses exactly one code and rejects reuse and administrative revocation after use', async () => {
    const user = await account(), a = await issue(user), b = await issue(user);
    await fill(user); await change(user, { kind: 'promo', promoCodeId: a.id });
    const order = await place(user, { promoCodeIds: [a.id, b.id], promoDiscount: 999999, total: 1 });
    expect(order).toMatchObject({ subtotal: 22000, promoDiscount: 5000, total: 17000 });
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('AVAILABLE');
    await fill(user); await change(user, { kind: 'promo', promoCodeId: a.id }, 409);
    await http().post('/api/admin/promo-codes/' + a.id + '/revoke').set('Cookie', admin.cookie).expect(409);
  });
  it('does not consume a code if the delivery address fails validation', async () => {
    const user = await account(), promo = await issue(user);
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    await checkout(user, (await basket(user)).revision, { type: 'DELIVERY' }).expect(400);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).status).toBe('AVAILABLE');
  });
  it('returns the same order for concurrent double-clicks with the same request identity', async () => {
    const user = await account(), promo = await issue(user);
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const revision = (await basket(user)).revision, checkoutRequestId = randomUUID();
    const responses = await Promise.all([checkout(user, revision, { checkoutRequestId }), checkout(user, revision, { checkoutRequestId })]);
    expect(responses.map(r => r.status)).toEqual([201, 201]);
    expect(responses[0]!.body.order.id).toBe(responses[1]!.body.order.id);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
  });
  it('allows one winner for two different concurrent checkout requests', async () => {
    const user = await account(), promo = await issue(user);
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const revision = (await basket(user)).revision;
    const responses = await Promise.all([checkout(user, revision), checkout(user, revision)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
  });
  it('serializes independent order transactions around the same single-use code', async () => {
    const user = await account(), promo = await issue(user), orders = app.get(OrderService);
    const input = orderSchema.parse({ type: 'PICKUP', customerName: 'Покупатель', customerPhone: '+79990000999',
      promoCodeId: promo.id, items: [{ productId, qty: 2 }] });
    const results = await Promise.allSettled([
      orders.create(user.id, undefined, { ...input, checkoutRequestId: randomUUID() }),
      orders.create(user.id, undefined, { ...input, checkoutRequestId: randomUUID() }),
    ]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
  });
  it('preserves free delivery through discount, settings changes, payment, delivery completion and history', async () => {
    const user = await account(), promo = await issue(user, { amount: 8000 });
    await db.shopSettings.update({ where: { id: 1 }, data: { freeDeliveryEnabled: true, freeDeliveryThreshold: 22000 } });
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    expect((await basket(user)).delivery).toMatchObject({ eligible: true, price: 0, remaining: 0 });
    const order = await place(user, { type: 'DELIVERY', address: { city: 'Москва', street: 'Барклая', house: '10' } });
    expect(order).toMatchObject({ total: 14000, deliveryPrice: 0, promoDiscount: 8000 });
    await db.shopSettings.update({ where: { id: 1 }, data: { freeDeliveryThreshold: 33000 } });
    await db.promoCode.update({ where: { id: promo.id }, data: { amount: 15000 } });
    await assemble(order.id);
    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } });
    expect(saved).toMatchObject({ finalSubtotal: 22000, finalPromoDiscount: 8000, finalTotal: 14000,
      freeDeliveryApplied: true, freeDeliveryThresholdSnapshot: 22000, payment: { amount: 14000 } });
    await staff.confirmPayment(order.id, seller.id, 'DELIVERY', { userId: seller.id, role: 'SELLER' });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } })).payment?.status).toBe('PAID');
    const actor = { userId: seller.id, role: 'SELLER' as const };
    await staff.delivery(order.id, { provider: 'OTHER', courierName: 'Тестовый курьер', courierPhone: '+79990000990', price: 15000 }, actor);
    await staff.handoff(order.id, actor); await staff.completeDelivery(order.id, actor);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { delivery: true } }))
      .toMatchObject({ status: 'COMPLETED', deliveryPrice: 0, finalTotal: 14000, delivery: { price: 15000 } });
    const detail = await http().get('/api/orders/' + order.publicId).set('Cookie', user.cookie).expect(200);
    expect(detail.body).toMatchObject({ finalPromoDiscount: 8000, finalTotal: 14000 });
    expect(JSON.stringify(detail.body)).not.toContain('private-delay-reason');
  });
  it('completes a discounted pickup and retains the discount in customer and admin history', async () => {
    const user = await account(), promo = await issue(user);
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const order = await place(user); await assemble(order.id);
    const actor = { userId: seller.id, role: 'SELLER' as const };
    await staff.confirmPayment(order.id, seller.id, 'PICKUP', actor); await staff.completePickup(order.id, actor);
    const history = await http().get('/api/orders').set('Cookie', user.cookie).expect(200);
    expect(history.body.find((o: { id: number }) => o.id === order.id)).toMatchObject({ status: 'COMPLETED', finalPromoDiscount: 5000, finalTotal: 17000 });
    const detail = await http().get('/api/admin/orders/' + order.id).set('Cookie', admin.cookie).expect(200);
    expect(detail.body).toMatchObject({ promoCodeSnapshot: promo.code, finalPromoDiscount: 5000 });
    await http().post('/api/staff/orders/' + order.id + '/cancel').set('Cookie', seller.cookie).send({}).expect(409);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).status).toBe('USED');
  });
  it('discounts goods only and preserves a separately priced paid delivery through completion', async () => {
    const user = await account(), promo = await issue(user), actor = { userId: seller.id, role: 'SELLER' as const };
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const order = await place(user, { type: 'DELIVERY', address: { city: 'Москва', street: 'Барклая', house: '10' } });
    await assemble(order.id); await staff.confirmPayment(order.id, seller.id, 'DELIVERY', actor);
    await staff.delivery(order.id, { provider: 'OTHER', courierName: 'Тестовый курьер', courierPhone: '+79990000990', price: 12000 }, actor);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } }))
      .toMatchObject({ subtotal: 22000, promoDiscount: 5000, deliveryPrice: 12000, total: 29000,
        finalSubtotal: 22000, finalPromoDiscount: 5000, finalTotal: 29000, payment: { amount: 17000 } });
    await staff.handoff(order.id, actor); await staff.completeDelivery(order.id, actor);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('COMPLETED');
  });
  it('recalculates weight discount from snapshots, excludes extras and keeps supplier prices', async () => {
    const user = await account(), promo = await issue(user, { type: 'PERCENT', amount: null, percentBps: 1000, maxDiscount: 100000 });
    await fill(user, 2000, gramId); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const order = await place(user), actor = { userId: seller.id, role: 'SELLER' as const };
    await staff.confirm(order.id, actor); await staff.startAssembly(order.id, actor);
    await staff.extra(order.id, seller.id, { title: 'Пакет', quantity: 1, unitPrice: 500 }, undefined, undefined, actor);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    await staff.item(order.id, item.id, { status: 'PICKED', actualQty: 1901 }, seller.id, actor); await staff.finishAssembly(order.id, actor);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } }))
      .toMatchObject({ finalSubtotal: 21411, finalPromoDiscount: 2091, finalTotal: 19320, payment: { amount: 19320 } });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ price: 11000, serviceMarkupPercentSnapshot: 10, actualTotal: 20911 });
  });
  it('supports a fully compensated zero-cost pickup without an unnecessary transfer', async () => {
    const user = await account(), promo = await issue(user, { amount: 100000 });
    await fill(user, 1); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const order = await place(user); expect(order.total).toBe(0); await assemble(order.id, 1);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } }))
      .toMatchObject({ finalTotal: 0, finalPromoDiscount: 11000, payment: { amount: 0, status: 'PAID' } });
    await staff.completePickup(order.id, { userId: seller.id, role: 'SELLER' });
  });
  it('releases once on cancellation, reclaims on restore, and preserves canceled order history', async () => {
    const user = await account(), promo = await issue(user), actor = { userId: seller.id, role: 'SELLER' as const };
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id });
    const order = await place(user); await assemble(order.id);
    await staff.cancel(order.id, seller.id, 'SELLER', 'Тестовая отмена', actor);
    await staff.cancel(order.id, seller.id, 'SELLER', undefined, actor);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).status).toBe('AVAILABLE');
    const cancellation = await db.orderCancellation.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { id: 'desc' } });
    await staff.restore(order.id, seller.id, 'SELLER', cancellation.id, actor);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).usedOrderId).toBe(order.id);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } })).toMatchObject({ status: 'READY', finalPromoDiscount: 5000, payment: { amount: 17000 } });
  });
  it('cannot restore an old canceled order after reuse, nor release the new use on repeated cancellation', async () => {
    const user = await account(), promo = await issue(user), actor = { userId: seller.id, role: 'SELLER' as const };
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id }); const first = await place(user);
    await staff.cancel(first.id, seller.id, 'SELLER', undefined, actor);
    const cancellation = await db.orderCancellation.findFirstOrThrow({ where: { orderId: first.id } });
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id }); const second = await place(user);
    await staff.cancel(first.id, seller.id, 'SELLER', undefined, actor);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).usedOrderId).toBe(second.id);
    await expect(staff.restore(first.id, seller.id, 'SELLER', cancellation.id, actor)).rejects.toThrow('Промокод уже недоступен');
    expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELED');
  });
  it('rejects restoration after expiry or revocation', async () => {
    const user = await account(), promo = await issue(user), actor = { userId: seller.id, role: 'SELLER' as const };
    await fill(user); await change(user, { kind: 'promo', promoCodeId: promo.id }); const order = await place(user);
    await staff.cancel(order.id, seller.id, 'SELLER', undefined, actor);
    const cancellation = await db.orderCancellation.findFirstOrThrow({ where: { orderId: order.id } });
    await db.promoCode.update({ where: { id: promo.id }, data: { expiresAt: new Date(0) } });
    await expect(staff.restore(order.id, seller.id, 'SELLER', cancellation.id, actor)).rejects.toThrow('Промокод уже недоступен');
    await http().post('/api/admin/promo-codes/' + promo.id + '/revoke').set('Cookie', admin.cookie).expect(201);
    await expect(staff.restore(order.id, seller.id, 'SELLER', cancellation.id, actor)).rejects.toThrow('Промокод уже недоступен');
  });
  it('enforces source-order ownership and administrative rights', async () => {
    const user = await account(), other = await account();
    await fill(other); const source = await place(other);
    await http().post('/api/admin/promo-codes').set('Cookie', admin.cookie).send({
      userId: user.id, title: 'Скидка', type: 'FIXED', amount: 100,
      expiresAt: new Date(Date.now()+86400000).toISOString(), reason: 'Компенсация', sourceOrderId: source.id,
    }).expect(400);
    const promo = await issue(user);
    for (const cookie of [user.cookie, seller.cookie, 'sid=missing']) {
      await http().get('/api/admin/promo-codes').set('Cookie', cookie).expect(403);
      await http().post('/api/admin/promo-codes').set('Cookie', cookie).send({}).expect(403);
      await http().post('/api/admin/promo-codes/' + promo.id + '/revoke').set('Cookie', cookie).expect(403);
    }
    await http().get('/api/promo-codes').expect(401);
    await http().post('/api/admin/promo-codes/' + promo.id + '/revoke').set('Cookie', admin.cookie).set('Origin', 'https://foreign.example').expect(403);
  });
});
