import 'dotenv/config';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import type { Server } from 'node:http';
import cookieParser from 'cookie-parser';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type DeliveryAttempt } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AppModule } from '../src/app.module.js';
import { YandexService, type YandexClaimInfo } from '../src/delivery/yandex.service.js';
import { DeliveryService } from '../src/delivery/delivery.service.js';
import { SID } from '../src/auth/auth.service.js';
import { OrderSmsProvider } from '../src/order/notification.service.js';

// Real PostgreSQL, isolated schema; no shop records or external provider calls.
describe.skipIf(!process.env.DATABASE_URL)('Phase 1 HTTP / PostgreSQL', () => {
  const schema = `phase1_test_${randomUUID().replaceAll('-', '')}`;
  const connection = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  let db: PrismaClient;
  let app: INestApplication<Server>;
  let created = false;
  let admin: string, seller: string, owner: string, stranger: string;
  let productId: number;
  const sms = { available: false, send: vi.fn(async () => {}) };
  // Stateful remote: create is idempotent by request_id, accept changes remote
  // state even when a test loses the response afterwards.
  const remote = new Map<string, YandexClaimInfo & { version: number }>();
  const requests = new Map<string, string>();
  const prepare = vi.fn(async () => '{"offer_payload":"snapshot"}');
  const createClaim = vi.fn(async (requestId: string, _body: string) => {
    const known = requests.get(requestId);
    if (known) return known;
    const claimId = randomUUID();
    requests.set(requestId, claimId);
    remote.set(claimId, {
      claimId, providerStatus: 'ready_for_approval', version: 1,
      providerUpdatedAt: new Date().toISOString(), price: 45000,
      priceIsFinal: false, currency: 'RUB', trackingUrl: null,
      courierName: null, etaMinutes: null,
    });
    return claimId;
  });
  const inspect = vi.fn(async (id: string) => ({ ...remote.get(id)! }));
  const accept = vi.fn(async (id: string, _version: number) => {
    remote.get(id)!.providerStatus = 'accepted';
    return 'accepted';
  });
  const sync = vi.fn(async (id: string) => ({ ...remote.get(id)! }));
  const yandex = {
    isSyncAvailable: () => false, isAvailable: () => true,
    prepare, create: createClaim, inspect, accept, sync,
    bulkInfo: vi.fn(async () => []),
  };
  const call = (cookie: string) => {
    const http = request(app.getHttpServer());
    return {
      get: (path: string) => http.get(`/api${path}`).set('Cookie', cookie),
      post: (path: string, body: object = {}) =>
        http.post(`/api${path}`).set('Cookie', cookie).send(body),
      patch: (path: string, body: object) =>
        http.patch(`/api${path}`).set('Cookie', cookie).send(body),
      put: (path: string, body: object) =>
        http.put(`/api${path}`).set('Cookie', cookie).send(body),
    };
  };
  async function session(role: 'USER' | 'SELLER' | 'ADMIN', phone: string) {
    const user = await db.user.create({ data: { phone, role, name: role } });
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return `${SID}=${token}`;
  }
  async function create(type = 'DELIVERY', cookie = owner) {
    const response = await call(cookie)
      .post('/orders', {
        type,
        customerName: 'Fixture',
        customerPhone: '+79990000103',
        ...(type === 'DELIVERY'
          ? { address: { city: 'Москва', street: 'Тестовая', house: '1' } }
          : {}),
        items: [{ productId, qty: 1000 }],
      })
      .expect(201);
    return {
      id: response.body.id as number,
      publicId: response.body.publicId as string,
      cookie:
        cookie ||
        (response.headers['set-cookie'] as unknown as string[])[0]!.split(
          ';',
        )[0]!,
    };
  }
  async function assemble(order: { id: number }, actualQty = 1037) {
    await call(seller).post(`/staff/orders/${order.id}/confirm`).expect(201);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/start`)
      .expect(201);
    const item = await db.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${item.id}`, {
        status: 'PICKED',
        actualQty,
      })
      .expect(200);
    return item.id;
  }
  beforeAll(async () => {
    vi.stubEnv('ADMIN_PHONE', '+79990000101');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    // All payment configuration is synthetic; never use local real requisites.
    for (const key of [
      'PAYMENT_PHONE',
      'PAYMENT_CARD_NUMBER',
      'PAYMENT_BANK_NAME',
      'PAYMENT_RECIPIENT_NAME',
      'PAYMENT_QR_IMAGE_URL',
    ])
      vi.stubEnv(key, '');
    vi.stubEnv('PAYMENT_SBP_LINK', 'https://example.test/payment');
    vi.stubEnv('ORDER_SMS_ENABLED', 'false');
    vi.stubEnv('ORDER_SITE_URL', 'https://example.test');
    await connection.connect();
    if (!/^phase1_test_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unsafe schema');
    await connection.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20260908120000_assembly_payment')
        await connection.query(
          `INSERT INTO "Order" ("customerName", "customerPhone", type, subtotal, "deliveryPrice", total, "updatedAt") VALUES ('Legacy fixture', '+79990000109', 'PICKUP', 123, 0, 123, NOW())`,
        );
      await connection.query(
        await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
      );
    }
    db = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: process.env.DATABASE_URL,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(db)
      .overrideProvider(YandexService)
      .useValue(yandex)
      .overrideProvider(OrderSmsProvider)
      .useValue(sms)
      .compile();
    app = module.createNestApplication<INestApplication<Server>>({
      logger: false,
    });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    admin = await session('ADMIN', '+79990000101');
    seller = await session('SELLER', '+79990000102');
    owner = await session('USER', '+79990000103');
    stranger = await session('USER', '+79990000104');
    const category = await db.category.create({
      data: { name: 'Fixture', slug: 'fixture' },
    });
    const product = await db.product.create({
      data: {
        name: 'Томаты',
        slug: 'tomato',
        categoryId: category.id,
        unit: 'GRAM',
        price: 100000,
        priceQty: 1000,
        min: 500,
        step: 100,
        portionQty: 500,
      },
    });
    productId = product.id;
    expect(await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      minDeliverySubtotal: 300000, maxOrderExtraUnitPrice: 500000, maxOrderExtrasTotal: 1000000, deliveryEnabled: true, pickupEnabled: true,
    });
    // Legacy lifecycle fixtures intentionally exercise small baskets independently of eligibility.
    await db.shopSettings.update({ where: { id: 1 }, data: { minDeliverySubtotal: 0 } });
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (created && /^phase1_test_[a-f0-9]{32}$/.test(schema))
      await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection.end();
    vi.unstubAllEnvs();
  }, 30000);

  it('business settings enforce public eligibility, protected extras, and safe corrections', async () => {
    const defaults = { minDeliverySubtotal: 300000, maxOrderExtraUnitPrice: 500000, maxOrderExtrasTotal: 1000000, deliveryEnabled: true, pickupEnabled: true };
    try {
      await call(admin).patch('/admin/settings', defaults).expect(200);
      expect((await call('').get('/shop/settings').expect(200)).body).toEqual({ minDeliverySubtotal: 300000, deliveryEnabled: true, pickupEnabled: true });
      for (const cookie of [seller, owner]) await call(cookie).patch('/admin/settings', { minDeliverySubtotal: 0 }).expect(403);
      await call(owner).get('/staff/extra-limits').expect(403);
      await call(seller).get('/staff/extra-limits').expect(200);
      await call(admin).patch('/admin/settings', { deliveryEnabled: false, pickupEnabled: false }).expect(400);
      for (const input of [{ minDeliverySubtotal: -1 }, { maxOrderExtraUnitPrice: 0 }, { maxOrderExtrasTotal: 1.5 }, { minDeliverySubtotal: 100000001 }])
        await call(admin).patch('/admin/settings', input).expect(400);
      const checkout = (type: string, qty = 2500) => call(owner).post('/orders', { type, customerName: 'Limits', customerPhone: '+79990000103', ...(type === 'DELIVERY' ? { address: { city: 'Москва', street: 'Тест', house: '1' } } : {}), items: [{ productId, qty }] });
      await checkout('DELIVERY').expect(400);
      const pickup = (await checkout('PICKUP').expect(201)).body;
      await checkout('DELIVERY', 3000).expect(201);
      await call(admin).patch('/admin/settings', { minDeliverySubtotal: 200000 }).expect(200);
      const old = (await checkout('DELIVERY').expect(201)).body;
      await call(admin).patch('/admin/settings', { minDeliverySubtotal: 400000 }).expect(200);
      await checkout('DELIVERY').expect(400);
      expect((await call(owner).get(`/orders/${old.publicId}`).expect(200)).body.subtotal).toBe(250000);
      await call(admin).patch('/admin/settings', { deliveryEnabled: false }).expect(200);
      await checkout('DELIVERY', 5000).expect(400);
      await call(admin).patch('/admin/settings', { deliveryEnabled: true, pickupEnabled: false }).expect(200);
      await checkout('PICKUP').expect(400);
      const id = pickup.id as number;
      await call(seller).post(`/staff/orders/${id}/confirm`).expect(201);
      await call(seller).post(`/staff/orders/${id}/assembly/start`).expect(201);
      const path = `/staff/orders/${id}/extras`;
      const service = { title: 'Упаковка', quantity: 1, unitPrice: 500000 };
      await call(owner).post(path, service).expect(403);
      await call(seller).post(path, { ...service, unitPrice: 500001 }).expect(400);
      const a = (await call(seller).post(path, service).expect(201)).body;
      const b = (await call(admin).post(path, service).expect(201)).body;
      await call(seller).post(path, { ...service, unitPrice: 1 }).expect(400);
      await call(admin).patch('/admin/settings', { maxOrderExtraUnitPrice: 200000, maxOrderExtrasTotal: 300000 }).expect(200);
      const reduced = (await call(seller).patch(`${path}/${a.id}`, { ...service, unitPrice: 400000, version: a.version }).expect(200)).body;
      await call(seller).post(`${path}/${b.id}/cancel`, { version: b.version }).expect(201);
      await call(seller).patch(`${path}/${a.id}`, { ...service, unitPrice: 200000, version: reduced.version }).expect(200);
      await call(seller).post(path, { ...service, unitPrice: 100000 }).expect(201);
      await call(seller).post(path, { ...service, unitPrice: 1 }).expect(400);
    } finally {
      await db.shopSettings.update({ where: { id: 1 }, data: { ...defaults, minDeliverySubtotal: 0 } });
    }
  });

  it('safe migration, singleton settings, guards, immutable order snapshot', async () => {
    const legacy = await db.order.findFirstOrThrow({
      where: { customerName: 'Legacy fixture' },
    });
    expect(legacy).toMatchObject({
      subtotal: 123,
      total: 123,
      weightToleranceBps: 1000,
      assemblyFinalizedAt: null,
    });
    expect(
      (await call(admin).get('/admin/settings').expect(200)).body
        .weightToleranceBps,
    ).toBe(1000);
    const old = await create();
    for (const cookie of [owner, seller]) {
      await call(cookie).get('/admin/settings').expect(403);
      await call(cookie)
        .patch('/admin/settings', { weightToleranceBps: 750 })
        .expect(403);
    }
    for (const weightToleranceBps of [-1, 5001, 7.5])
      await call(admin)
        .patch('/admin/settings', { weightToleranceBps })
        .expect(400);
    await call(admin)
      .patch('/admin/settings', { weightToleranceBps: 750 })
      .expect(200);
    const newer = await create();
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: old.id } }))
        .weightToleranceBps,
    ).toBe(1000);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: newer.id } }))
        .weightToleranceBps,
    ).toBe(750);
    expect(await db.shopSettings.count()).toBe(1);
  });

  it.each([1100, 1101, 2000])(
    'finalize 1000g → %ig uses the order snapshot and is atomic',
    async (actualQty) => {
      await call(admin)
        .patch('/admin/settings', { weightToleranceBps: 1000 })
        .expect(200);
      const order = await create();
      // Later settings changes cannot widen this order's tolerance.
      await call(admin)
        .patch('/admin/settings', { weightToleranceBps: 5000 })
        .expect(200);
      const itemId = await assemble(order, actualQty);
      const response = await call(seller)
        .post(`/staff/orders/${order.id}/assembly/finish`)
        .expect(actualQty === 1100 ? 201 : 409);
      const saved = await db.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { payment: true, items: true },
      });
      expect(saved.items.find((item) => item.id === itemId)?.actualQty).toBe(
        actualQty,
      );
      if (actualQty === 1100) {
        expect(saved.status).toBe('READY');
        expect(saved.assemblyFinalizedAt).not.toBeNull();
        expect(saved.payment).toMatchObject({
          status: 'AWAITING',
          amount: 110000,
        });
      } else {
        expect(response.body.message).toContain(
          'Требуется подтверждение покупателя',
        );
        expect(response.body.code).toBe('WEIGHT_CONFIRMATION_REQUIRED');
        expect(response.body.itemIds).toEqual([itemId]);
        expect(saved).toMatchObject({
          status: 'ASSEMBLING',
          assemblyFinalizedAt: null,
          finalSubtotal: null,
          finalTotal: null,
          payment: null,
        });
        const customer = await call(owner)
          .get(`/orders/${order.publicId}`)
          .expect(200);
        expect(customer.body.payment).toBeNull();
        expect(customer.body.paymentDetails).toBeNull();
      }
      await call(admin)
        .patch('/admin/settings', { weightToleranceBps: 750 })
        .expect(200);
    },
  );

  it('one outside GRAM item rejects the entire assembly without touching another line', async () => {
    await call(admin)
      .patch('/admin/settings', { weightToleranceBps: 1000 })
      .expect(200);
    const order = await create();
    await assemble(order, 1100);
    const item = await db.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const { id: _id, ...snapshot } = item;
    await db.orderItem.create({
      data: { ...snapshot, actualQty: 2000, actualTotal: 200000 },
    });
    const before = await db.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { id: 'asc' },
    });
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(409);
    expect(
      await db.orderItem.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
    expect(
      await db.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { payment: true },
      }),
    ).toMatchObject({
      status: 'ASSEMBLING',
      assemblyFinalizedAt: null,
      finalSubtotal: null,
      payment: null,
    });
    await call(admin)
      .patch('/admin/settings', { weightToleranceBps: 750 })
      .expect(200);
  });

  it('snapshot pricing, concurrent finalize/report/confirm, paid-only delivery and immutability', async () => {
    const order = await create();
    expect(
      (await call(owner).get(`/orders/${order.publicId}`)).body.paymentDetails,
    ).toBeNull();
    await db.product.update({
      where: { id: productId },
      data: { price: 120000 },
    });
    const itemId = await assemble(order);
    const finish = `/staff/orders/${order.id}/assembly/finish`;
    await Promise.all([
      call(seller).post(finish).expect(201),
      call(admin).post(finish).expect(201),
    ]);
    expect(await db.orderPayment.count({ where: { orderId: order.id } })).toBe(
      1,
    );
    expect(
      await db.orderPayment.findUnique({ where: { orderId: order.id } }),
    ).toMatchObject({ status: 'AWAITING', amount: 103700 });
    const booking = `/staff/orders/${order.id}/delivery/yandex/order`;
    const otherDelivery = () =>
      call(seller)
        .put(`/staff/orders/${order.id}/delivery`, {
          provider: 'OTHER',
          price: 500,
          courierName: 'Fixture',
          courierPhone: '+79990000105',
        })
        .expect(409);
    await call(seller).post(booking).expect(409);
    await otherDelivery();
    expect(createClaim).not.toHaveBeenCalled();
    await call(stranger)
      .post(`/orders/${order.publicId}/payment/report`, { method: 'SBP' })
      .expect(404);
    await call(owner)
      .post(`/staff/orders/${order.id}/payment/confirm`)
      .expect(403);
    await call(owner)
      .post(`/orders/${order.publicId}/payment/report`, {
        method: 'SBP',
        status: 'PAID',
      })
      .expect(400);
    const report = `/orders/${order.publicId}/payment/report`;
    await Promise.all([
      call(owner).post(report, { method: 'SBP' }).expect(201),
      call(owner).post(report, { method: 'SBP' }).expect(201),
    ]);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/reopen`)
      .expect(409);
    await call(seller).post(booking).expect(409);
    await otherDelivery();
    expect(createClaim).not.toHaveBeenCalled();
    const confirm = `/staff/orders/${order.id}/payment/confirm`;
    await Promise.all([
      call(seller).post(confirm).expect(201),
      call(admin).post(confirm).expect(201),
      call(seller)
        .post(`/staff/orders/${order.id}/assembly/reopen`)
        .expect(409),
    ]);
    const paid = await db.orderPayment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(paid.status).toBe('PAID');
    expect(paid.confirmedById).not.toBeNull();
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/reopen`)
      .expect(409);
    await call(seller).post(`/staff/orders/${order.id}/cancel`).expect(409);
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${itemId}`, { status: 'PENDING' })
      .expect(400);
    await call(seller).post(booking).expect(201);
    expect(createClaim).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.orderPayment.findUniqueOrThrow({
          where: { orderId: order.id },
        })
      ).amount,
    ).toBe(103700);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .finalTotal,
    ).toBe(148700);
    await call(owner).post(report, { method: 'SBP' }).expect(201);
  });

  it('guest ownership, unpaid pickup rejection, reopen/cancel invalidate payment', async () => {
    const order = await create('PICKUP', '');
    await assemble(order, 1000);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(201);
    await call(seller)
      .post(`/staff/orders/${order.id}/pickup/complete`)
      .expect(409);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/reopen`)
      .expect(201);
    await call(order.cookie)
      .post(`/orders/${order.publicId}/payment/report`, { method: 'SBP' })
      .expect(409);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(201);
    const other = await create('PICKUP', '');
    await call(other.cookie)
      .post(`/orders/${order.publicId}/payment/report`, { method: 'SBP' })
      .expect(404);
    await call(order.cookie)
      .post(`/staff/orders/${order.id}/payment/confirm`)
      .expect(401);
    await call(order.cookie)
      .post(`/orders/${order.publicId}/payment/report`, { method: 'SBP' })
      .expect(201);
    await call(seller)
      .post(`/staff/orders/${order.id}/payment/confirm`)
      .expect(201);
    await call(seller)
      .post(`/staff/orders/${order.id}/pickup/complete`)
      .expect(201);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('COMPLETED');
    await assemble(other, 1000);
    await call(seller)
      .post(`/staff/orders/${other.id}/assembly/finish`)
      .expect(201);
    await call(other.cookie)
      .post(`/orders/${other.publicId}/payment/report`, { method: 'SBP' })
      .expect(201);
    await call(seller).post(`/staff/orders/${other.id}/cancel`).expect(409);
    // REPORTED is legacy and needs manual payment verification, not reversible cancellation.
    await db.orderPayment.update({ where: { orderId: other.id }, data: { status: 'AWAITING', reportedAt: null } });
    await call(seller).post(`/staff/orders/${other.id}/cancel`).expect(201);
    expect(
      (
        await db.orderPayment.findUniqueOrThrow({
          where: { orderId: other.id },
        })
      ).status,
    ).toBe('CANCELED');
    await call(other.cookie)
      .post(`/orders/${other.publicId}/payment/report`, { method: 'SBP' })
      .expect(409);
  });

  async function phase2Order(actualQty = 1200, cookie = owner) {
    await call(admin)
      .patch('/admin/settings', {
        weightToleranceBps: 1000,
        customerResponseMinutes: 10,
      })
      .expect(200);
    await db.product.update({
      where: { id: productId },
      data: { price: 100000, priceQty: 1000 },
    });
    const order = await create('PICKUP', cookie);
    const itemId = await assemble(order, actualQty);
    return { ...order, itemId };
  }
  const issueFor = (id: number) =>
    db.orderIssue.findFirstOrThrow({ where: { orderId: id } });
  const decision = (
    order: { publicId: string; cookie: string },
    issue: { id: number; version: number },
    action: string,
  ) =>
    call(order.cookie).post(
      `/orders/${order.publicId}/issues/${issue.id}/decision`,
      { version: issue.version, action },
    );

  it.each([1101, 1200, 2000])(
    'PHASE 2 exact approval of %ig → finalized goods payment, never direct finalize',
    async (actualQty) => {
      const order = await phase2Order(actualQty);
      let issue = await issueFor(order.id);
      expect(issue).toMatchObject({
        type: 'WEIGHT_DEVIATION',
        status: 'WAITING_CUSTOMER',
        actualQty,
        approvedActualQty: null,
      });
      await call(seller)
        .post(`/staff/orders/${order.id}/assembly/finish`)
        .expect(409);
      await call(order.cookie)
        .post(`/orders/${order.publicId}/messages`, {
          text: 'Подтверждаю после обсуждения',
        })
        .expect(201);
      await decision(order, issue, 'ACCEPT_ACTUAL').expect(201);
      await decision(order, issue, 'ACCEPT_ACTUAL').expect(201);
      issue = await issueFor(order.id);
      expect(issue).toMatchObject({
        status: 'RESOLVED',
        approvedActualQty: actualQty,
      });
      await call(seller)
        .post(`/staff/orders/${order.id}/assembly/finish`)
        .expect(201);
      expect(
        await db.orderPayment.findUniqueOrThrow({
          where: { orderId: order.id },
        }),
      ).toMatchObject({ status: 'AWAITING', amount: actualQty * 100 });
      await call(order.cookie)
        .post(`/orders/${order.publicId}/payment/report`, { method: 'SBP' })
        .expect(201);
      await call(seller)
        .post(`/staff/orders/${order.id}/payment/confirm`)
        .expect(201);
      expect(
        await db.orderPayment.findUniqueOrThrow({
          where: { orderId: order.id },
        }),
      ).toMatchObject({ status: 'PAID' });
      await decision(order, issue, 'REMOVE_ITEM').expect(409);
      expect(
        await db.orderNotification.count({
          where: { orderId: order.id, channel: 'SMS', type: 'PAYMENT_READY' },
        }),
      ).toBe(1);
    },
  );

  it('PHASE 2 inclusive boundary has no issue; approval becomes stale on reset/change; reduce resolves', async () => {
    const boundary = await phase2Order(1100);
    expect(await db.orderIssue.count({ where: { orderId: boundary.id } })).toBe(
      0,
    );
    const order = await phase2Order(2000);
    const old = await issueFor(order.id);
    await decision(order, old, 'ACCEPT_ACTUAL').expect(201);
    const path = `/staff/orders/${order.id}/items/${order.itemId}`;
    await call(seller).patch(path, { status: 'PENDING' }).expect(200);
    await call(seller)
      .patch(path, { status: 'PICKED', actualQty: 2100 })
      .expect(200);
    const changed = await issueFor(order.id);
    expect(changed.version).toBeGreaterThan(old.version);
    expect(changed.approvedActualQty).toBeNull();
    await decision(order, old, 'ACCEPT_ACTUAL').expect(409);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(409);
    await decision(order, changed, 'REQUEST_REDUCE').expect(201);
    expect((await issueFor(order.id)).status).toBe('WAITING_SELLER');
    await call(seller).patch(path, { status: 'PENDING' }).expect(200);
    await call(seller)
      .patch(path, { status: 'PICKED', actualQty: 1050 })
      .expect(200);
    expect(await issueFor(order.id)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'SELLER_ADJUSTED',
    });
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(201);
  });

  it('PHASE 2 concurrent reset vs customer approval cannot approve the new weight', async () => {
    const order = await phase2Order(2000);
    const issue = await issueFor(order.id);
    const responses = await Promise.all([
      decision(order, issue, 'ACCEPT_ACTUAL'),
      call(seller).patch(`/staff/orders/${order.id}/items/${order.itemId}`, {
        status: 'PENDING',
      }),
    ]);
    expect([201, 409]).toContain(responses[0]!.status);
    expect(responses[1]!.status).toBe(200);
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${order.itemId}`, {
        status: 'PICKED',
        actualQty: 2100,
      })
      .expect(200);
    expect(await issueFor(order.id)).toMatchObject({
      status: 'WAITING_CUSTOMER',
      approvedActualQty: null,
      actualQty: 2100,
    });
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(409);
  });

  it('PHASE 2 missing removal and replacement preserve history and proposal price, duplicates are idempotent', async () => {
    const order = await phase2Order(1000);
    const path = `/staff/orders/${order.id}/items/${order.itemId}`;
    await call(seller).patch(path, { status: 'PENDING' }).expect(200);
    await call(seller).patch(path, { status: 'MISSING' }).expect(200);
    const missing = await issueFor(order.id);
    expect(missing).toMatchObject({
      status: 'WAITING_CUSTOMER',
      type: 'MISSING_ITEM',
    });
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(409);
    await call(seller)
      .post(`/staff/orders/${order.id}/issues/${missing.id}/proposal`, {
        version: missing.version,
        productId,
        qty: 500,
      })
      .expect(201);
    const proposal = await issueFor(order.id);
    await db.product.update({
      where: { id: productId },
      data: { price: 199000 },
    });
    await decision(order, missing, 'ACCEPT_REPLACEMENT').expect(409);
    await Promise.all([
      decision(order, proposal, 'ACCEPT_REPLACEMENT').expect(201),
      decision(order, proposal, 'ACCEPT_REPLACEMENT').expect(201),
    ]);
    const resolved = await issueFor(order.id);
    const replacement = await db.orderItem.findUniqueOrThrow({
      where: { id: resolved.replacementItemId! },
    });
    expect(replacement).toMatchObject({
      price: 100000,
      qty: 500,
      total: 50000,
      status: 'PENDING',
    });
    expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(2);
    expect(
      await db.orderItem.findUniqueOrThrow({ where: { id: order.itemId } }),
    ).toMatchObject({ status: 'MISSING', actualTotal: 0 });
    await call(seller).patch(path, { status: 'PENDING' }).expect(409);
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${replacement.id}`, {
        status: 'PICKED',
        actualQty: 500,
      })
      .expect(200);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(201);
    expect(
      (
        await db.orderPayment.findUniqueOrThrow({
          where: { orderId: order.id },
        })
      ).amount,
    ).toBe(50000);
    const remove = await phase2Order(1200);
    await decision(remove, await issueFor(remove.id), 'REMOVE_ITEM').expect(
      201,
    );
    expect(
      await db.orderItem.findUniqueOrThrow({ where: { id: remove.itemId } }),
    ).toMatchObject({ status: 'MISSING', actualTotal: 0 });
    expect((await issueFor(remove.id)).status).toBe('RESOLVED');
  });

  it('PHASE 2 owner/guest chat, IDOR, validation, cursor paging and monotonic unread acknowledgments', async () => {
    for (const cookie of [owner, '']) {
      const order = await phase2Order(1200, cookie);
      const base = `/orders/${order.publicId}`;
      const staffBase = `/staff/orders/${order.id}`;
      await call(stranger).get(`${base}/coordination`).expect(404);
      await call(stranger).get(`${base}/messages`).expect(404);
      await call('').get(`${base}/messages`).expect(404);
      await call(stranger)
        .post(`${base}/messages`, { text: 'IDOR' })
        .expect(404);
      await call(owner).get(`${staffBase}/messages`).expect(403);
      await call(order.cookie)
        .post(`${base}/messages`, { text: '   ' })
        .expect(400);
      await call(order.cookie)
        .post(`${base}/messages`, { text: 'x'.repeat(2001) })
        .expect(400);
      const html = '<img src=x onerror=alert(1)>';
      const posted = await call(order.cookie)
        .post(`${base}/messages`, { text: html })
        .expect(201);
      await call(seller)
        .post(`${staffBase}/messages`, { text: 'Добрый день' })
        .expect(201);
      const page = await call(order.cookie)
        .get(`${base}/messages?after=${posted.body.id}&limit=1`)
        .expect(200);
      expect(page.body.messages).toHaveLength(1);
      expect(page.body.messages[0].text).toBe('Добрый день');
      const previous = await call(order.cookie)
        .get(`${base}/messages?before=${page.body.messages[0].id}&limit=1`)
        .expect(200);
      expect(previous.body.messages[0].text).toBe(html);
      expect(
        (await call(seller).get(`${staffBase}/coordination`)).body.unread,
      ).toBeGreaterThan(0);
      await call(seller)
        .post(`${staffBase}/messages/read`, {
          through: page.body.messages[0].id,
        })
        .expect(201);
      expect(
        (await call(seller).get(`${staffBase}/coordination`)).body.unread,
      ).toBe(0);
      await call(seller)
        .post(`${staffBase}/messages/read`, { through: posted.body.id })
        .expect(201);
      expect(
        (await call(seller).get(`${staffBase}/coordination`)).body.unread,
      ).toBe(0);
      await decision(order, await issueFor(order.id), 'ACCEPT_ACTUAL').expect(
        201,
      );
    }
  });

  it('PHASE 2 persisted notification dedupe, new versions, disabled SMS, provider failure and timeout validation', async () => {
    const order = await phase2Order(1200);
    const path = `/staff/orders/${order.id}/items/${order.itemId}`;
    expect(
      await db.orderNotification.findFirst({ where: { orderId: order.id, channel: 'SMS' } }),
    ).toMatchObject({ type: 'ACTION_REQUIRED', status: 'UNCONFIGURED' });
    await call(seller)
      .patch(path, { status: 'PICKED', actualQty: 1200 })
      .expect(200);
    expect(
      await db.orderNotification.count({ where: { orderId: order.id, channel: 'SMS' } }),
    ).toBe(1);
    sms.available = true;
    vi.stubEnv('ORDER_SMS_ENABLED', 'true');
    sms.send.mockRejectedValueOnce(
      new Error('synthetic outage: must not be persisted'),
    );
    await call(seller).patch(path, { status: 'PENDING' }).expect(200);
    await call(seller)
      .patch(path, { status: 'PICKED', actualQty: 1250 })
      .expect(200);
    expect(
      await db.orderNotification.count({ where: { orderId: order.id, channel: 'SMS' } }),
    ).toBe(2);
    expect(
      await db.orderNotification.findFirst({
        where: { orderId: order.id, channel: 'SMS' },
        orderBy: { id: 'desc' },
      }),
    ).toMatchObject({ status: 'FAILED', error: 'SMS_SEND_FAILED' });
    expect(await issueFor(order.id)).toMatchObject({
      actualQty: 1250,
      status: 'WAITING_CUSTOMER',
    });
    sms.available = false;
    vi.stubEnv('ORDER_SMS_ENABLED', 'false');
    for (const customerResponseMinutes of [0, 121, 1.5])
      await call(admin)
        .patch('/admin/settings', {
          weightToleranceBps: 1000,
          customerResponseMinutes,
        })
        .expect(400);
    await call(admin)
      .patch('/admin/settings', {
        weightToleranceBps: 1000,
        customerResponseMinutes: 12,
      })
      .expect(200);
    expect(
      (await call(seller).get(`/staff/orders/${order.id}/coordination`)).body
        .responseMinutes,
    ).toBe(12);
  });

  it('PHASE 2 cancellation closes issues and payment is never created', async () => {
    const order = await phase2Order(1200, '');
    const issue = await issueFor(order.id);
    await decision(order, issue, 'CANCEL_ORDER').expect(201);
    await decision(order, issue, 'CANCEL_ORDER').expect(201);
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('CANCELED');
    expect((await issueFor(order.id)).status).toBe('CANCELED');
    expect(await db.orderPayment.count({ where: { orderId: order.id } })).toBe(
      0,
    );
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/finish`)
      .expect(400);
  });

  it('PHASE 2.1 extras are staff-only, versioned, hidden until finalized and included in the one payment', async () => {
    const order = await phase2Order(1000);
    const path = `/staff/orders/${order.id}/extras`;
    const input = { title: 'Нарезка', comment: 'Помыть и нарезать', quantity: 1, unitPrice: 50000 };
    await call(owner).post(path, input).expect(403);
    await call('').post(path, input).expect(401);
    const extra = (await call(seller).post(path, input).expect(201)).body;
    expect(extra.amount).toBe(50000);
    expect(await db.orderIssue.count({ where: { orderId: order.id } })).toBe(0);
    expect((await call(owner).get(`/orders/${order.publicId}`)).body.extras).toEqual([]);
    await call(seller).post(path, { ...input, quantity: 10000, unitPrice: 2147483647 }).expect(400);
    const other = await phase2Order(1000);
    await call(seller).patch(`/staff/orders/${other.id}/extras/${extra.id}`, { ...input, version: extra.version }).expect(404);
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    let detail = (await call(owner).get(`/orders/${order.publicId}`).expect(200)).body;
    expect(detail.finalSubtotal).toBe(150000);
    expect(detail.payment).toMatchObject({ amount: 150000, status: 'AWAITING' });
    expect(detail.extras).toHaveLength(1);
    await call(seller).patch(`${path}/${extra.id}`, { ...input, version: extra.version }).expect(409);
    await call(seller).post(`/staff/orders/${order.id}/assembly/reopen`).expect(201);
    await call(admin).post(`${path}/${extra.id}/cancel`, { version: extra.version }).expect(201);
    expect((await db.orderExtra.findUniqueOrThrow({ where: { id: extra.id } })).status).toBe('CANCELED');
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    detail = (await call(owner).get(`/orders/${order.publicId}`)).body;
    expect(detail.finalSubtotal).toBe(100000);
    expect(detail.payment).toMatchObject({ amount: 100000, status: 'AWAITING' });
    expect(detail.extras).toEqual([]);
    await call(owner).post(`/staff/orders/${order.id}/payment/confirm`).expect(403);
    await call(seller).post(`/staff/orders/${order.id}/payment/confirm`).expect(201);
    await call(seller).post(`/staff/orders/${order.id}/assembly/reopen`).expect(409);
    await call(admin).post(path, input).expect(409);
    await call(seller).post(`/staff/orders/${order.id}/pickup/complete`).expect(201);
  });

  it('PHASE 2.1 delivery failure preserves committed PAID and retry preserves payment audit and one event', async () => {
    await db.shopSettings.update({ where: { id: 1 }, data: { weightToleranceBps: 1000 } });
    await db.product.update({ where: { id: productId }, data: { price: 100000 } });
    const order = await create();
    await assemble(order, 1000);
    await call(seller).post(`/staff/orders/${order.id}/extras`, { title: 'Нарезка', quantity: 1, unitPrice: 50000 }).expect(201);
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    const endpoint = `/staff/orders/${order.id}/delivery/yandex/confirm`;
    await call(owner).post(endpoint).expect(403);
    await call('').post(endpoint).expect(401);
    createClaim.mockRejectedValueOnce(new Error('Synthetic provider outage'));
    const failure = await call(seller).post(endpoint);
    expect(failure.status).toBe(502);
    const paid = await db.orderPayment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.amount).toBe(150000);
    expect(paid.confirmedAt).not.toBeNull();
    await call(admin).post(endpoint).expect(201);
    const retried = await db.orderPayment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(retried.confirmedAt).toEqual(paid.confirmedAt);
    expect(retried.confirmedById).toBe(paid.confirmedById);
    expect(retried.amount).toBe(150000);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).finalTotal).toBe(195000);
    expect(await db.orderChatMessage.count({ where: { orderId: order.id, text: 'Оплата получена. Оформляем доставку.' } })).toBe(1);
  });

  it('PHASE 2.1 concurrent extra edits reject stale versions; finalization and payment lock charges', async () => {
    const order = await phase2Order(1000);
    const path = `/staff/orders/${order.id}/extras`;
    const input = { title: 'Упаковка', quantity: 2, unitPrice: 30000 };
    const extra = (await call(admin).post(path, input).expect(201)).body;
    const edits = await Promise.all([
      call(seller).patch(`${path}/${extra.id}`, { ...input, title: 'Новая упаковка', version: extra.version }),
      call(admin).patch(`${path}/${extra.id}`, { ...input, title: 'Другая упаковка', version: extra.version }),
    ]);
    expect(edits.map(result => result.status).sort()).toEqual([200, 409]);
    const updated = await db.orderExtra.findUniqueOrThrow({ where: { id: extra.id } });
    expect(updated.version).toBe(2);
    expect(updated.amount).toBe(60000);
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    const confirm = `/staff/orders/${order.id}/payment/confirm`;
    await Promise.all([call(seller).post(confirm).expect(201), call(admin).post(confirm).expect(201)]);
    expect(await db.orderChatMessage.count({ where: { orderId: order.id, text: 'Оплата получена.' } })).toBe(1);
    await call(seller).post(`${path}/${extra.id}/cancel`, { version: updated.version }).expect(409);
    const payment = await db.orderPayment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(payment).toMatchObject({ status: 'PAID', amount: 160000 });
    expect(await db.orderIssue.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('PHASE 2.1 header unread separates customer/staff and respects owner and guest access', async () => {
    for (const cookie of [owner, '']) {
      const order = await phase2Order(1000, cookie);
      const customer = call(order.cookie);
      const before = (await customer.get('/orders/unread').expect(200)).body.count;
      const previousOrderUnread = (await customer.get(`/orders/${order.publicId}/coordination`).expect(200)).body.unread;
      const staffBeforeOwn = (await call(seller).get('/staff/orders/unread').expect(200)).body.count;
      const entry = (await call(seller).post(`/staff/orders/${order.id}/messages`, { text: 'Здравствуйте' }).expect(201)).body;
      expect((await call(seller).get('/staff/orders/unread')).body.count).toBe(staffBeforeOwn);
      const summary = (await customer.get('/orders/unread').expect(200)).body;
      expect(summary.count).toBe(before + 1);
      expect(summary.latestOrderId).toBe(order.publicId);
      await customer.post(`/orders/${order.publicId}/messages/read`, { through: entry.id }).expect(201);
      expect((await customer.get('/orders/unread')).body.count).toBe(before - previousOrderUnread);
      const staffBefore = (await call(seller).get('/staff/orders/unread')).body.count;
      const reply = (await customer.post(`/orders/${order.publicId}/messages`, { text: 'Спасибо' }).expect(201)).body;
      expect((await customer.get('/orders/unread')).body.count).toBe(before - previousOrderUnread);
      const staffSummary = (await call(seller).get('/staff/orders/unread').expect(200)).body;
      expect(staffSummary.count).toBe(staffBefore + 1);
      expect(staffSummary.latestOrderId).toBe(order.id);
      await call(seller).post(`/staff/orders/${order.id}/messages/read`, { through: reply.id }).expect(201);
      expect((await call(seller).get('/staff/orders/unread')).body.count).toBe(staffBefore);
    }
    await call(owner).get('/staff/orders/unread').expect(403);
    expect((await call(stranger).get('/orders/unread')).body.count).toBe(0);
  });

  it('PHASE 2.2 NEW summary is compact, guarded and excludes confirmed/canceled', async () => {
    const previous = await db.order.findMany({ where: { status: 'NEW' }, select: { id: true } });
    const ids = previous.map(row => row.id);
    await db.order.updateMany({ where: { id: { in: ids } }, data: { status: 'CONFIRMED' } });
    try {
      await call(owner).get('/staff/orders/new-summary').expect(403);
      await call('').get('/staff/orders/new-summary').expect(401);
      expect((await call(seller).get('/staff/orders/new-summary').expect(200)).body).toEqual({ count: 0, latestOrderId: null });
      const order = await create('PICKUP');
      expect((await call(admin).get('/staff/orders/new-summary').expect(200)).body).toEqual({ count: 1, latestOrderId: order.id });
      await Promise.all([call(seller).post(`/staff/orders/${order.id}/confirm`).expect(201), call(admin).post(`/staff/orders/${order.id}/confirm`).expect(201)]);
      expect((await call(seller).get('/staff/orders/new-summary')).body.count).toBe(0);
      const canceled = await create('PICKUP');
      await request(app.getHttpServer()).post(`/api/staff/orders/${canceled.id}/cancel`).set('Cookie', seller).expect(201);
      expect((await call(admin).get('/staff/orders/new-summary')).body.count).toBe(0);
    } finally {
      await db.order.updateMany({ where: { id: { in: ids } }, data: { status: 'NEW' } });
    }
  });

  it.each(['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'] as const)('PHASE 2.2 cancel/restore %s preserves snapshots, audit and one payment', async (status) => {
    const order = await create('PICKUP');
    if (status === 'CONFIRMED') await call(seller).post(`/staff/orders/${order.id}/confirm`).expect(201);
    if (status === 'ASSEMBLING' || status === 'READY') await assemble(order, 1000);
    if (status === 'READY') await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    const before = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payment: true } });
    const endpoint = `/staff/orders/${order.id}`;
    await call(owner).post(`${endpoint}/cancel`, { reason: 'Нет' }).expect(403);
    await call(seller).post(`${endpoint}/cancel`, { reason: 'x'.repeat(1001) }).expect(400);
    await call(seller).post(`${endpoint}/cancel`, { reason: 'Служебная причина' }).expect(201);
    await call(admin).post(`${endpoint}/cancel`, { reason: 'Не перезаписывать' }).expect(201);
    const canceled = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payment: true, cancellations: true } });
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.items).toEqual(before.items);
    expect(canceled.cancellations).toHaveLength(1);
    const record = canceled.cancellations[0]!;
    expect(record).toMatchObject({ fromStatus: status, reason: 'Служебная причина', canceledByRole: 'SELLER' });
    expect(record.canceledById).not.toBeNull();
    expect(record.canceledAt).toBeInstanceOf(Date);
    expect((await call(owner).get(`/orders/${order.publicId}`).expect(200)).text).not.toContain('Служебная причина');
    if (status === 'READY') expect(canceled.payment?.status).toBe('CANCELED');
    await call(seller).post(`${endpoint}/payment/confirm`).expect(409);
    await call(owner).post(`${endpoint}/restore`, { cancellationId: record.id }).expect(403);
    await call('').post(`${endpoint}/restore`, { cancellationId: record.id }).expect(401);
    await Promise.all([call(admin).post(`${endpoint}/restore`, { cancellationId: record.id }).expect(201), call(seller).post(`${endpoint}/restore`, { cancellationId: record.id }).expect(201)]);
    const restored = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payment: true, cancellations: true } });
    expect(restored.status).toBe(status);
    expect(restored.items).toEqual(before.items);
    expect(restored.finalSubtotal).toBe(before.finalSubtotal);
    expect(restored.payment?.amount).toBe(before.payment?.amount);
    if (status === 'READY') expect(restored.payment?.status).toBe('AWAITING');
    expect(restored.cancellations[0]!.restoredAt).toBeInstanceOf(Date);
    expect(restored.cancellations[0]!.restoredById).not.toBeNull();
    expect(await db.orderChatMessage.count({ where: { orderId: order.id, text: 'Заказ отменён продавцом.' } })).toBe(1);
    expect(await db.orderChatMessage.count({ where: { orderId: order.id, text: 'Заказ восстановлен.' } })).toBe(1);
    await call(seller).post(`${endpoint}/cancel`).expect(201);
    await call(seller).post(`${endpoint}/restore`, { cancellationId: record.id }).expect(409);
    const second = await db.orderCancellation.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { id: 'desc' } });
    await call(seller).post(`${endpoint}/restore`, { cancellationId: second.id }).expect(201);
    expect(await db.orderCancellation.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('PHASE 2.2 restore preserves pending decisions, approvals, extras and chat; stale decision cannot replay', async () => {
    const order = await phase2Order(1200);
    const issue = await issueFor(order.id);
    await decision(order, issue, 'REQUEST_REDUCE').expect(201);
    const requested = await issueFor(order.id);
    const extra = (await call(seller).post(`/staff/orders/${order.id}/extras`, { title: 'Нарезка', quantity: 1, unitPrice: 50000 }).expect(201)).body;
    const chat = (await call(owner).post(`/orders/${order.publicId}/messages`, { text: 'Сохранить историю' }).expect(201)).body;
    const path = `/staff/orders/${order.id}`;
    await Promise.all([call(seller).post(`${path}/cancel`, { reason: 'A' }).expect(201), call(admin).post(`${path}/cancel`, { reason: 'B' }).expect(201)]);
    const canceledIssue = await issueFor(order.id);
    expect(canceledIssue.status).toBe('CANCELED');
    expect(canceledIssue.suspendedStatus).toBe('WAITING_SELLER');
    const cancellation = await db.orderCancellation.findFirstOrThrow({ where: { orderId: order.id } });
    await call(seller).post(`${path}/restore`, { cancellationId: cancellation.id }).expect(201);
    const restored = await issueFor(order.id);
    expect(restored).toMatchObject({ status: 'WAITING_SELLER', resolution: 'REQUEST_REDUCE' });
    expect(restored.version).toBeGreaterThan(requested.version);
    expect(await db.orderChatMessage.findUnique({ where: { id: chat.id } })).not.toBeNull();
    expect(await db.orderExtra.findUnique({ where: { id: extra.id } })).toMatchObject({ amount: 50000, status: 'ACTIVE' });
    await call(seller).post(`${path}/assembly/finish`).expect(409);
    await decision(order, issue, 'ACCEPT_ACTUAL').expect(409);
  });

  it('PHASE 2.2 WAITING_CUSTOMER survives cancellation and requires fresh approval after restore', async () => {
    const order = await phase2Order(2000);
    const old = await issueFor(order.id);
    await call(seller).post(`/staff/orders/${order.id}/cancel`).expect(201);
    const record = await db.orderCancellation.findFirstOrThrow({ where: { orderId: order.id } });
    await call(seller).post(`/staff/orders/${order.id}/restore`, { cancellationId: record.id }).expect(201);
    const current = await issueFor(order.id);
    expect(current.status).toBe('WAITING_CUSTOMER');
    expect(current.actualQty).toBe(2000);
    await decision(order, old, 'ACCEPT_ACTUAL').expect(409);
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(409);
    await decision(order, current, 'ACCEPT_ACTUAL').expect(201);
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
  });

  it('PHASE 2.2 legacy canceled cannot restore, completed and canceled queries are disjoint', async () => {
    const canceled = await create('PICKUP');
    const completed = await create('PICKUP');
    await db.order.update({ where: { id: canceled.id }, data: { status: 'CANCELED' } });
    await db.order.update({ where: { id: completed.id }, data: { status: 'COMPLETED' } });
    const detail = (await call(seller).get(`/staff/orders/${canceled.id}`).expect(200)).body;
    expect(detail.restoreProblem).toContain('прежнее состояние неизвестно');
    await call(seller).post(`/staff/orders/${canceled.id}/restore`, { cancellationId: 1 }).expect(409);
    const finishedRows = (await call(admin).get('/staff/orders?status=COMPLETED').expect(200)).body as { id: number; status: string }[];
    const canceledRows = (await call(seller).get('/staff/orders?status=CANCELED').expect(200)).body as { id: number; status: string }[];
    expect(finishedRows.every(row => row.status === 'COMPLETED')).toBe(true);
    expect(canceledRows.every(row => row.status === 'CANCELED')).toBe(true);
    expect(finishedRows.some(row => row.id === completed.id)).toBe(true);
    expect(canceledRows.some(row => row.id === canceled.id)).toBe(true);
    await call(seller).post(`/staff/orders/${completed.id}/cancel`).expect(400);
    await db.order.update({ where: { id: completed.id }, data: { status: 'DELIVERING' } });
    await call(seller).post(`/staff/orders/${completed.id}/cancel`).expect(400);
  });

  it('PHASE 2.2 cancel/payment and cancel/finalize serialize without CANCELED + actionable payment', async () => {
    const order = await phase2Order(1000);
    const base = `/staff/orders/${order.id}`;
    await Promise.all([call(seller).post(`${base}/assembly/finish`), call(admin).post(`${base}/cancel`)]);
    const canceled = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } });
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.payment === null || canceled.payment.status === 'CANCELED').toBe(true);
    const ready = await phase2Order(1000);
    const path = `/staff/orders/${ready.id}`;
    await call(seller).post(`${path}/assembly/finish`).expect(201);
    const race = await Promise.all([call(seller).post(`${path}/payment/confirm`), call(admin).post(`${path}/cancel`)]);
    expect(race.map(result => result.status).sort()).toEqual([201, 409]);
    const result = await db.order.findUniqueOrThrow({ where: { id: ready.id }, include: { payment: true } });
    expect(result.status === 'CANCELED' ? result.payment?.status === 'CANCELED' : result.payment?.status === 'PAID').toBe(true);
  });

  it('PENDING and outside weight block finalize; MISSING is zero and overflow is 400', async () => {
    const order = await create();
    await call(seller).post(`/staff/orders/${order.id}/confirm`).expect(201);
    await call(seller)
      .post(`/staff/orders/${order.id}/assembly/start`)
      .expect(201);
    const finish = `/staff/orders/${order.id}/assembly/finish`;
    await call(seller).post(finish).expect(400);
    const item = await db.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${item.id}`, {
        status: 'PICKED',
        actualQty: 1180,
      })
      .expect(200);
    await call(seller).post(finish).expect(409);
    expect(
      await db.orderPayment.findUnique({ where: { orderId: order.id } }),
    ).toBeNull();
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${item.id}`, {
        status: 'PENDING',
      })
      .expect(200);
    await call(seller)
      .patch(`/staff/orders/${order.id}/items/${item.id}`, {
        status: 'MISSING',
      })
      .expect(200);
    expect(
      (await db.orderItem.findUniqueOrThrow({ where: { id: item.id } }))
        .actualTotal,
    ).toBe(0);
    await call(seller).post(finish).expect(409);
    await db.orderItem.create({
      data: {
        orderId: order.id,
        productName: 'Упаковка',
        productSlug: 'pack',
        unit: 'PACK',
        qty: 1,
        actualQty: 2,
        price: 100,
        priceQty: 1,
        total: 100,
        actualTotal: 1,
        status: 'PICKED',
      },
    });
    await call(seller).post(finish).expect(409);
    const missingIssue = await issueFor(order.id);
    await decision(order, missingIssue, 'REMOVE_ITEM').expect(201);
    await call(seller).post(finish).expect(201);
    expect(
      (
        await db.orderPayment.findUniqueOrThrow({
          where: { orderId: order.id },
        })
      ).amount,
    ).toBe(200);
    await db.product.update({
      where: { id: productId },
      data: { price: 100000000, priceQty: 1 },
    });
    await call(owner)
      .post('/orders', {
        type: 'PICKUP',
        customerName: 'Fixture',
        customerPhone: '+79990000103',
        items: [{ productId, qty: 1000 }],
      })
      .expect(400);
  });

  async function recoveryOrder() {
    await db.shopSettings.update({ where: { id: 1 }, data: { minDeliverySubtotal: 0, weightToleranceBps: 1000 } });
    await db.product.update({ where: { id: productId }, data: { price: 100000, priceQty: 1000 } });
    const order = await create();
    await assemble(order, 1000);
    await call(seller).post(`/staff/orders/${order.id}/assembly/finish`).expect(201);
    return { ...order, endpoint: `/staff/orders/${order.id}/delivery/yandex/confirm` };
  }

  // Real database failures, not a rejected mock of the whole booking operation.
  async function failBookingWrite(orderId: number, stage: 'claim-db' | 'delivery-db') {
    const table = stage === 'claim-db' ? 'DeliveryAttempt' : 'Delivery';
    const condition = stage === 'claim-db'
      ? `NEW."orderId" = ${orderId} AND OLD."externalOrderId" IS NULL AND NEW."externalOrderId" IS NOT NULL`
      : `NEW."orderId" = ${orderId}`;
    await connection.query(`CREATE FUNCTION h1_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'Synthetic H1 DB failure'; END IF; RETURN NEW; END $$`);
    await connection.query(`CREATE TRIGGER h1_fail_write BEFORE ${stage === 'claim-db' ? 'UPDATE' : 'INSERT'} ON "${table}" FOR EACH ROW EXECUTE FUNCTION h1_fail_write()`);
    return async () => {
      await connection.query(`DROP TRIGGER h1_fail_write ON "${table}"`);
      await connection.query('DROP FUNCTION h1_fail_write()');
    };
  }

  it.each(['create', 'accept', 'sync', 'claim-db', 'delivery-db'] as const)(
    'H1 recovers the same remote claim after %s failure and preserves PAID',
    async stage => {
      const order = await recoveryOrder();
      const beforeClaims = remote.size;
      const beforePrepare = prepare.mock.calls.length;
      const beforeAccept = accept.mock.calls.length;
      let cleanup: (() => Promise<void>) | undefined;
      if (stage === 'create') {
        const impl = createClaim.getMockImplementation()!;
        createClaim.mockImplementationOnce(async (...args) => {
          await impl(...args); throw new Error('Lost create response after remote success');
        });
      } else if (stage === 'accept') {
        const impl = accept.getMockImplementation()!;
        accept.mockImplementationOnce(async (...args) => {
          await impl(...args); throw new Error('Lost accept response after remote success');
        });
      } else if (stage === 'sync') {
        sync.mockRejectedValueOnce(new Error('Sync timeout after acceptance'));
      } else {
        cleanup = await failBookingWrite(order.id, stage);
      }
      try { await call(seller).post(order.endpoint).expect(502); }
      finally { await cleanup?.(); }
      const paid = await db.orderPayment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(paid).toMatchObject({ status: 'PAID', amount: 100000 });
      const pending = await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(pending.requestId).toBe(order.publicId);
      expect(pending.requestBody).toBe('{"offer_payload":"snapshot"}');
      expect(pending.leaseToken).toBeNull();
      expect(pending.lastError).not.toBeNull();
      const remoteId = requests.get(order.publicId)!;
      expect(remote.size).toBe(beforeClaims + 1);
      expect(pending.externalOrderId).toBe(['create', 'claim-db'].includes(stage) ? null : remoteId);
      expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(0);
      await call(admin).post(order.endpoint).expect(201);
      const active = await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(active).toMatchObject({
        state: 'ACTIVE', externalOrderId: remoteId, requestId: order.publicId,
        lastError: null, leaseToken: null,
      });
      expect(active.acceptedAt).not.toBeNull();
      expect(active.completedAt).not.toBeNull();
      expect(remote.size).toBe(beforeClaims + 1);
      expect(prepare.mock.calls.length).toBe(beforePrepare + 1);
      expect(accept.mock.calls.length).toBe(beforeAccept + 1);
      const replayBodies = createClaim.mock.calls.filter(([id]) => id === order.publicId).map(([, body]) => body);
      expect(new Set(replayBodies).size).toBe(1);
      expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
      expect(await db.orderPayment.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
        status: 'PAID', amount: paid.amount, confirmedAt: paid.confirmedAt, confirmedById: paid.confirmedById,
      });
      expect(await db.orderChatMessage.count({
        where: { orderId: order.id, text: 'Оплата получена. Оформляем доставку.' },
      })).toBe(1);
      // Lost successful HTTP response is also idempotent after ACTIVE.
      const creates = createClaim.mock.calls.length;
      await call(admin).post(order.endpoint).expect(201);
      expect(createClaim.mock.calls.length).toBe(creates);
    },
  );

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it.each(['YANDEX', 'OTHER'] as const)('H1 blocks parallel %s while Yandex is reserved before HTTP completes', async provider => {
    const order = await recoveryOrder();
    const started = barrier(), release = barrier();
    const impl = createClaim.getMockImplementation()!;
    createClaim.mockImplementationOnce(async (...args) => {
      started.resolve(); await release.promise; return impl(...args);
    });
    const first = call(seller).post(order.endpoint).then(response => response);
    await started.promise;
    try {
      expect(await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
        state: 'RESERVED', externalOrderId: null,
      });
      const second = provider === 'YANDEX'
        ? call(admin).post(order.endpoint)
        : call(admin).put(`/staff/orders/${order.id}/delivery`, {
            provider: 'OTHER', price: 500, courierName: 'Fixture', courierPhone: '+79990000105',
          });
      await second.expect(409);
      expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(0);
    } finally { release.resolve(); }
    expect((await first).status).toBe(201);
    expect(createClaim.mock.calls.filter(([id]) => id === order.publicId)).toHaveLength(1);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('H1 reclaims an expired process lease and fences the old worker without another claim', async () => {
    const order = await recoveryOrder();
    const started = barrier(), release = barrier();
    const impl = createClaim.getMockImplementation()!;
    createClaim.mockImplementationOnce(async (...args) => {
      const id = await impl(...args);
      started.resolve(); await release.promise; return id;
    });
    const first = call(seller).post(order.endpoint).then(response => response);
    await started.promise;
    let active: DeliveryAttempt | undefined;
    try {
      await db.deliveryAttempt.update({ where: { orderId: order.id }, data: { leaseUntil: new Date(0) } });
      await call(admin).post(order.endpoint).expect(201);
      active = await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } });
    } finally { release.resolve(); }
    expect((await first).status).toBe(409);
    expect(await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } })).toEqual(active);
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
    expect(createClaim.mock.calls.filter(([id]) => id === order.publicId)).toHaveLength(2);
    expect(active?.externalOrderId).toBe(requests.get(order.publicId));
  });

  it.each(['failed', 'cancelled', 'unknown_provider_state'])('H1 retains %s for manual review and blocks OTHER', async status => {
    const order = await recoveryOrder();
    const impl = inspect.getMockImplementation()!;
    inspect.mockImplementationOnce(async id => {
      remote.get(id)!.providerStatus = status; return impl(id);
    });
    const beforeAccept = accept.mock.calls.length;
    await call(seller).post(order.endpoint).expect(409);
    expect(await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
      state: 'NEEDS_REVIEW', providerStatus: status,
      externalOrderId: requests.get(order.publicId),
    });
    await call(admin).put(`/staff/orders/${order.id}/delivery`, {
      provider: 'OTHER', price: 500, courierName: 'Fixture', courierPhone: '+79990000105',
    }).expect(409);
    await call(admin).post(order.endpoint).expect(409);
    expect(accept.mock.calls.length).toBe(beforeAccept);
    expect(createClaim.mock.calls.filter(([id]) => id === order.publicId)).toHaveLength(1);
    expect((await db.orderPayment.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('PAID');
  });

  it('H1 background recovery finds a claim without local Delivery after an accept/sync failure', async () => {
    const order = await recoveryOrder();
    sync.mockRejectedValueOnce(new Error('Sync outage'));
    await call(seller).post(order.endpoint).expect(502);
    await db.deliveryAttempt.update({
      where: { orderId: order.id }, data: { updatedAt: new Date(Date.now() - 60_000) },
    });
    const available = vi.spyOn(yandex, 'isSyncAvailable').mockReturnValue(true);
    try {
      await app.get(DeliveryService).syncActiveYandexDeliveries();
    } finally { available.mockRestore(); }
    expect((await db.deliveryAttempt.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe('ACTIVE');
    expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('H1 preserves legacy local bookings and does not invent another attempt', async () => {
    const order = await recoveryOrder();
    await call(seller).post(order.endpoint).expect(201);
    await db.deliveryAttempt.delete({ where: { orderId: order.id } });
    const creates = createClaim.mock.calls.length;
    await call(admin).post(order.endpoint).expect(201);
    expect(createClaim.mock.calls.length).toBe(creates);
    expect(await db.deliveryAttempt.findUnique({ where: { orderId: order.id } })).toBeNull();
  });

  it.each([
    ['delivered_finish', 'COMPLETED'], ['returned_finish', 'DELIVERING'],
  ])('H1 reconciles a progressed %s claim without another accept or lifecycle rollback', async (status, expected) => {
    const order = await recoveryOrder();
    sync.mockRejectedValueOnce(new Error('Process lost sync result'));
    await call(seller).post(order.endpoint).expect(502);
    const accepts = accept.mock.calls.length;
    remote.get(requests.get(order.publicId)!)!.providerStatus = status!;
    await call(admin).post(order.endpoint).expect(201);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(expected);
    expect(accept.mock.calls.length).toBe(accepts);
    await call(admin).post(order.endpoint).expect(201);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(expected);
  });
});
