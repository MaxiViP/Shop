import 'dotenv/config';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile, utimes, unlink, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
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
import sharp from 'sharp';
import { ChatCleanupService } from '../src/order/chat-cleanup.service.js';
import { ChatImagesService } from '../src/order/chat-images.service.js';

// Real PostgreSQL, isolated schema; no shop records or external provider calls.
describe.skipIf(!process.env.DATABASE_URL)('Phase 1 HTTP / PostgreSQL', () => {
  const schema = `phase1_test_${randomUUID().replaceAll('-', '')}`;
  const connection = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  let db: PrismaClient;
  let app: INestApplication<Server>;
  let created = false;
  let chatDirectory = '';
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
    const cart = cookie ? (await call(cookie).get('/cart').expect(200)).body : null;
    const changed = cart
      ? (await call(cookie).post('/cart/change', { revision: cart.revision, kind: 'set', productId, qty: 1000 }).expect(201)).body
      : null;
    const response = await call(cookie)
      .post(cookie ? '/cart/checkout' : '/orders', {
        ...(changed ? { revision: changed.revision } : {}),
        type,
        customerName: 'Fixture',
        customerPhone: '+79990000103',
        ...(type === 'DELIVERY'
          ? { address: { city: 'Москва', street: 'Тестовая', house: '1' } }
          : {}),
        ...(!cookie ? { items: [{ productId, qty: 1000 }] } : {}),
      })
      .expect(201);
    const order = cookie ? response.body.order : response.body;
    return {
      id: order.id as number,
      publicId: order.publicId as string,
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
    chatDirectory = await mkdtemp(join(tmpdir(), 'shop-chat-e2e-'));
    vi.stubEnv('CHAT_UPLOAD_DIR', chatDirectory);
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
      if (entry.name === '20261001120000_admin_operations') {
        const before = await connection.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "Order" WHERE "customerName" = 'Legacy fixture'`,
        );
        expect(before.rows[0]?.count).toBe('1');
        await connection.query(`INSERT INTO "OrderItem"
          ("orderId", "productName", "productSlug", price, "priceQty", unit, qty, total)
          SELECT id, 'Legacy item', 'legacy-item', 123, 1, 'PIECE', 1, 123
          FROM "Order" WHERE "customerName" = 'Legacy fixture'`);
      }
      await connection.query(
        await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
      );
    }
    // Keep unrelated order-flow fixtures independent of the test wall clock.
    await connection.query('UPDATE "ShopHours" SET "openMinutes" = 0, "closeMinutes" = 1440');
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
    if (chatDirectory) {
      const child = relative(tmpdir(), chatDirectory);
      if (!/^shop-chat-e2e-[^\\/]+$/.test(child)) throw new Error('Unsafe chat test directory');
      await rm(chatDirectory, { recursive: true, force: true });
    }
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
      const checkout = async (type: 'DELIVERY' | 'PICKUP', qty = 2500, expected = 201) => {
        const cart = (await call(owner).get('/cart').expect(200)).body;
        const changed = (await call(owner).post('/cart/change', { revision: cart.revision, kind: 'set', productId, qty }).expect(201)).body;
        return call(owner).post('/cart/checkout', { revision: changed.revision, type, customerName: 'Limits', customerPhone: '+79990000103', ...(type === 'DELIVERY' ? { address: { city: 'Москва', street: 'Тестовая', house: '1' } } : {}) }).expect(expected);
      };
      await checkout('DELIVERY', 2500, 400);
      const pickup = (await checkout('PICKUP')).body.order;
      await checkout('DELIVERY', 3000);
      await call(admin).patch('/admin/settings', { minDeliverySubtotal: 200000 }).expect(200);
      const old = (await checkout('DELIVERY')).body.order;
      await call(admin).patch('/admin/settings', { minDeliverySubtotal: 400000 }).expect(200);
      await checkout('DELIVERY', 2500, 400);
      expect((await call(owner).get(`/orders/${old.publicId}`).expect(200)).body.subtotal).toBe(250000);
      await call(admin).patch('/admin/settings', { deliveryEnabled: false }).expect(200);
      await checkout('DELIVERY', 5000, 400);
      await call(admin).patch('/admin/settings', { deliveryEnabled: true, pickupEnabled: false }).expect(200);
      await checkout('PICKUP', 2500, 400);
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
      completedAt: null,
    });
    const legacyItem = await db.orderItem.findFirstOrThrow({ where: { orderId: legacy.id } });
    expect(legacyItem).toMatchObject({ settlementModeSnapshot: null, basePriceSnapshot: null });
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
    await db.product.update({ where: { id: productId },
      data: { settlementMode: 'SHARED_MARKUP', basePrice: 30000 } });
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
      data: { price: 199000, basePrice: 32000 },
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
      settlementModeSnapshot: 'SHARED_MARKUP',
      basePriceSnapshot: 32000,
    });
    await db.product.update({ where: { id: productId },
      data: { settlementMode: 'NO_MARKUP', basePrice: null } });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: replacement.id } }))
      .toMatchObject({ settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 32000 });
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
    await db.product.update({ where: { id: productId },
      data: { settlementMode: 'UNSET', basePrice: null } });
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

  it('private chat photos support owner, guest, seller and admin while rejecting invalid files and foreign access', async () => {
    const column = await connection.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'OrderChatMessage' AND column_name = 'imageKey'`,
    );
    expect(column.rows[0]?.data_type).toBe('uuid');
    const lifecycleColumns = await connection.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'OrderChatMessage' AND column_name IN ('imageRetention', 'imageExpiresAt', 'imageDeletedAt', 'imageRequestId')`,
    );
    expect(lifecycleColumns.rows.map(row => row.column_name).sort()).toEqual(['imageDeletedAt', 'imageExpiresAt', 'imageRequestId', 'imageRetention']);
    expect(await db.order.findFirst({ where: { customerName: 'Legacy fixture' } })).not.toBeNull();

    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#e11d48' } }).png().toBuffer();
    const customer = await create('PICKUP');
    const guest = await create('PICKUP', '');
    const customerBase = `/orders/${customer.publicId}`;
    const staffBase = `/staff/orders/${customer.id}`;
    const upload = (cookie: string, base: string, text: string, buffer = png, contentType = 'image/png') =>
      request(app.getHttpServer()).post(`/api${base}/messages/image`).set('Cookie', cookie)
        .field('text', text).attach('file', buffer, { filename: 'photo.png', contentType });

    const denied = await upload(stranger, customerBase, '', png);
    expect(denied.status, JSON.stringify(denied.body)).toBe(404);
    await upload('', customerBase, '', png).expect(404);
    await upload(owner, staffBase, '', png).expect(403);
    await upload(owner, customerBase, '', png, 'image/svg+xml').expect(400);
    await upload(owner, customerBase, '', png, 'image/jpeg').expect(400);
    await upload(owner, customerBase, '', Buffer.alloc(20 * 1024 * 1024 + 1)).expect(413);
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(10_000, 16);
    bomb.writeUInt32BE(7_000, 20);
    let crc = 0xffffffff;
    for (const byte of bomb.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    bomb.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    await upload(owner, customerBase, '', bomb).expect(400);
    const filesBeforeFailedMessage = await readdir(chatDirectory);
    await request(app.getHttpServer()).post(`/api${customerBase}/messages/image`)
      .set('Cookie', owner).field('text', '').field('issueId', '999999')
      .attach('file', png, { filename: 'photo.png', contentType: 'image/png' }).expect(400);
    expect(await readdir(chatDirectory)).toEqual(filesBeforeFailedMessage);
    await request(app.getHttpServer()).post(`/api${customerBase}/messages/image`)
      .set('Cookie', owner).field('text', '').expect(400);

    const fromCustomer = await upload(owner, customerBase, 'Посмотрите на фото').expect(201);
    expect(fromCustomer.body).toMatchObject({ text: 'Посмотрите на фото', image: true });
    expect(fromCustomer.body).not.toHaveProperty('imageKey');
    const fromStaff = await upload(seller, staffBase, '').expect(201);
    expect(fromStaff.body).toMatchObject({ text: '', image: true });
    const fromAdmin = await upload(admin, staffBase, 'Комментарий администратора').expect(201);
    expect(fromAdmin.body.image).toBe(true);
    const fromGuest = await upload(guest.cookie, `/orders/${guest.publicId}`, '').expect(201);
    expect(fromGuest.body.image).toBe(true);

    const page = await call(owner).get(`${customerBase}/messages`).expect(200);
    expect(page.body.messages.filter((entry: { image: boolean }) => entry.image)).toHaveLength(3);
    expect(page.body.messages[0]).not.toHaveProperty('imageKey');
    const photoPath = `${customerBase}/messages/${fromStaff.body.id}/image`;
    const photo = await call(owner).get(photoPath).expect(200);
    expect(photo.headers['content-type']).toMatch(/^image\/webp/);
    expect(photo.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(photo.headers['x-content-type-options']).toBe('nosniff');
    expect(photo.headers['content-disposition']).toMatch(/^inline; filename="photo.webp"/);
    expect((await sharp(photo.body as Buffer).metadata()).format).toBe('webp');
    const thumbnail = await call(owner).get(`${customerBase}/messages/${fromStaff.body.id}/thumbnail`).expect(200);
    expect(thumbnail.headers['content-type']).toMatch(/^image\/webp/);
    expect(thumbnail.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect((await sharp(thumbnail.body as Buffer).metadata()).format).toBe('webp');
    await call(stranger).get(photoPath).expect(404);
    await call(stranger).get(`${customerBase}/messages/${fromStaff.body.id}/thumbnail`).expect(404);
    await call('').get(photoPath).expect(404);
    await call(guest.cookie).get(photoPath).expect(404);
    await call(owner).get(`${staffBase}/messages/${fromStaff.body.id}/image`).expect(403);
    await call(seller).get(`${staffBase}/messages/${fromStaff.body.id}/image`).expect(200);
    await call(admin).get(`${staffBase}/messages/${fromStaff.body.id}/image`).expect(200);
    await call(seller).get(`${staffBase}/messages/${fromGuest.body.id}/image`).expect(404);
    await call(guest.cookie).get(`/orders/${guest.publicId}/messages/${fromGuest.body.id}/image`).expect(200);
  });

  it('market photo revisions keep one message, original audit file, and idempotent seller/customer markup', async () => {
    const order = await create('PICKUP');
    const staffBase = `/staff/orders/${order.id}`;
    const customerBase = `/orders/${order.publicId}`;
    const original = await sharp({ create: { width: 1500, height: 900, channels: 3, background: '#e11d48' } }).png().toBuffer();
    const upload = (cookie: string, base: string, image: Buffer, text: string, requestId = randomUUID()) =>
      request(app.getHttpServer()).post(`/api${base}/messages/image`).set('Cookie', cookie)
        .field('text', text).field('requestId', requestId)
        .attach('file', image, { filename: 'market.png', contentType: 'image/png' });
    const revise = (cookie: string, base: string, messageId: number, image: Buffer,
      text: string, requestId = randomUUID(), contentType = 'image/png') =>
      request(app.getHttpServer()).post(`/api${base}/messages/${messageId}/revisions`).set('Cookie', cookie)
        .field('text', text).field('requestId', requestId)
        .attach('file', image, { filename: 'marked.png', contentType });

    const cleanup = vi.spyOn(app.get(ChatImagesService), 'removeTemp')
      .mockRejectedValueOnce(Object.assign(new Error('Synthetic Windows lock'), { code: 'EBUSY' }));
    try {
      const idempotencyKey = randomUUID();
      const sellerPhoto = await upload(seller, staffBase, original, '', idempotencyKey).expect(201);
      expect(sellerPhoto.body).toMatchObject({ image: true, text: '' });
      expect(cleanup).toHaveBeenCalled();
      const retry = await upload(seller, staffBase, original, '', idempotencyKey).expect(201);
      expect(retry.body.id).toBe(sellerPhoto.body.id);
      expect(await db.orderChatMessage.count({ where: { orderId: order.id, imageRequestId: idempotencyKey } })).toBe(1);
      expect(await db.orderChatMessage.count({ where: { orderId: order.id, imageKey: { not: null } } })).toBe(1);

      const sellerCaption = await upload(seller, staffBase, original, 'Выберите помидоры').expect(201);
      expect(sellerCaption.body).toMatchObject({ image: true, text: 'Выберите помидоры' });
      const originalKey = (await db.orderChatMessage.findUniqueOrThrow({ where: { id: sellerCaption.body.id } })).imageKey!;
      const messageCount = await db.orderChatMessage.count({ where: { orderId: order.id } });
      const full = await call(owner).get(`${customerBase}/messages/${sellerCaption.body.id}/image`).expect(200);
      const fullMetadata = await sharp(full.body as Buffer).metadata();
      expect(fullMetadata).toMatchObject({ format: 'webp', width: 1500, height: 900 });
      const annotated = await sharp(full.body as Buffer)
        .composite([{ input: Buffer.from('<svg width="1500" height="900"><circle cx="750" cy="450" r="120" fill="none" stroke="yellow" stroke-width="20"/></svg>') }])
        .png().toBuffer();
      const requestId = randomUUID();
      await revise(stranger, customerBase, sellerCaption.body.id, annotated, 'Чужая разметка').expect(404);
      await revise(owner, staffBase, sellerCaption.body.id, annotated, 'Чужая разметка').expect(403);
      await revise(owner, customerBase, sellerCaption.body.id, annotated, 'Неверный MIME', randomUUID(), 'image/jpeg').expect(400);
      const customerReply = await revise(owner, customerBase, sellerCaption.body.id, annotated,
        'Вот эти, пожалуйста', requestId).expect(201);
      expect(customerReply.body).toMatchObject({ id: sellerCaption.body.id, image: true,
        text: 'Выберите помидоры', imageRevision: 1, revisionText: 'Вот эти, пожалуйста' });
      expect(await db.orderChatMessage.count({ where: { orderId: order.id } })).toBe(messageCount);
      const sellerView = await call(seller).get(`${staffBase}/messages/${sellerCaption.body.id}/image`).expect(200);
      expect((await sharp(sellerView.body as Buffer).metadata()).format).toBe('webp');
      const originalPixel = await sharp(full.body as Buffer).extract({ left: 750, top: 330, width: 1, height: 1 }).raw().toBuffer();
      const markedPixel = await sharp(sellerView.body as Buffer).extract({ left: 750, top: 330, width: 1, height: 1 }).raw().toBuffer();
      expect(markedPixel[1]!).toBeGreaterThan(originalPixel[1]! + 100);
      expect(await readFile(join(chatDirectory, originalKey + '.full.webp'))).toEqual(full.body);
      const repeated = await revise(owner, customerBase, sellerCaption.body.id, annotated,
        'Вот эти, пожалуйста', requestId).expect(201);
      expect(repeated.body).toMatchObject({ id: sellerCaption.body.id, imageRevision: 1 });
      const secondMark = await revise(seller, staffBase, sellerCaption.body.id, annotated, 'Уточнение продавца').expect(201);
      expect(secondMark.body).toMatchObject({ id: sellerCaption.body.id, imageRevision: 2,
        revisionText: 'Уточнение продавца' });
      expect(await db.orderChatMessage.count({ where: { orderId: order.id } })).toBe(messageCount);
      expect(await db.orderChatImageRevision.count({ where: { messageId: sellerCaption.body.id } })).toBe(3);
      const revisionRows = await db.orderChatImageRevision.findMany({ where: { messageId: sellerCaption.body.id },
        orderBy: { version: 'asc' } });
      expect(revisionRows.map(row => [row.version, row.actorType, row.caption])).toEqual([
        [0, 'SELLER', ''], [1, 'CUSTOMER', 'Вот эти, пожалуйста'], [2, 'SELLER', 'Уточнение продавца'],
      ]);
      const polled = await call(seller).get(`${staffBase}/messages`).query({ after: sellerCaption.body.id, seen: sellerCaption.body.id }).expect(200);
      expect(polled.body.messages).toHaveLength(0);
      expect(polled.body.revisions).toMatchObject([{ id: sellerCaption.body.id, imageRevision: 2 }]);

      const customerPhoto = await upload(owner, customerBase, original, '').expect(201);
      const staffFull = await call(seller).get(`${staffBase}/messages/${customerPhoto.body.id}/image`).expect(200);
      const staffMarked = await sharp(staffFull.body as Buffer)
        .composite([{ input: Buffer.from('<svg width="1500" height="900"><circle cx="500" cy="450" r="100" fill="none" stroke="cyan" stroke-width="20"/></svg>') }])
        .png().toBuffer();
      const staffReply = await revise(seller, staffBase, customerPhoto.body.id, staffMarked, 'Этот товар?').expect(201);
      expect(staffReply.body).toMatchObject({ id: customerPhoto.body.id, imageRevision: 1, revisionText: 'Этот товар?' });
      const adminReply = await revise(admin, staffBase, customerPhoto.body.id, staffMarked, 'Уточнение администратора').expect(201);
      expect(adminReply.body).toMatchObject({ id: customerPhoto.body.id, imageRevision: 2 });
      await call(owner).get(`${customerBase}/messages/${customerPhoto.body.id}/thumbnail`).expect(200);
      await call(stranger).get(`${customerBase}/messages/${customerPhoto.body.id}/image`).expect(404);

      const guestOrder = await create('PICKUP', '');
      const guestBase = `/orders/${guestOrder.publicId}`;
      const guestPhoto = await upload(guestOrder.cookie, guestBase, original, '').expect(201);
      const guestMark = await revise(guestOrder.cookie, guestBase, guestPhoto.body.id, annotated, 'Вот это').expect(201);
      expect(guestMark.body).toMatchObject({ id: guestPhoto.body.id, imageRevision: 1 });
      await revise(owner, guestBase, guestPhoto.body.id, annotated, 'Чужой заказ').expect(404);
    } finally {
      cleanup.mockRestore();
    }
  });

  it('photo revisions raise only the other side unread and read clears them on the same message', async () => {
    const order = await create('PICKUP');
    const staffBase = `/staff/orders/${order.id}`;
    const customerBase = `/orders/${order.publicId}`;
    const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#86efac' } }).png().toBuffer();
    const photo = await request(app.getHttpServer()).post(`/api${staffBase}/messages/image`)
      .set('Cookie', seller).field('text', '').field('requestId', randomUUID())
      .attach('file', png, { filename: 'market.png', contentType: 'image/png' }).expect(201);
    const messageCount = await db.orderChatMessage.count({ where: { orderId: order.id } });
    await call(owner).post(`${customerBase}/messages/read`, { through: photo.body.id }).expect(201);
    await call(seller).post(`${staffBase}/messages/read`, { through: photo.body.id }).expect(201);
    expect((await call(owner).get(`${customerBase}/coordination`)).body.unread).toBe(0);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(0);
    const revise = (cookie: string, base: string, requestId: string, text: string) =>
      request(app.getHttpServer()).post(`/api${base}/messages/${photo.body.id}/revisions`)
        .set('Cookie', cookie).field('text', text).field('requestId', requestId)
        .attach('file', png, { filename: 'marked.png', contentType: 'image/png' });

    const customerRequest = randomUUID();
    const customerMark = await revise(owner, customerBase, customerRequest, 'Эти помидоры').expect(201);
    expect(customerMark.body).toMatchObject({ id: photo.body.id, imageRevision: 1 });
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(1);
    expect((await call(owner).get(`${customerBase}/coordination`)).body.unread).toBe(0);
    expect((await call(seller).get('/staff/orders/unread')).body.latestOrderId).toBe(order.id);
    await revise(owner, customerBase, customerRequest, 'Эти помидоры').expect(201);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(1);
    expect(await db.orderChatMessage.count({ where: { orderId: order.id } })).toBe(messageCount);
    await call(seller).post(`${staffBase}/messages/read`, { through: photo.body.id }).expect(201);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(0);

    const sellerMark = await revise(seller, staffBase, randomUUID(), 'Вот эти?').expect(201);
    expect(sellerMark.body).toMatchObject({ id: photo.body.id, imageRevision: 2 });
    expect((await call(owner).get(`${customerBase}/coordination`)).body.unread).toBe(1);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(0);
    expect((await call(owner).get('/orders/unread')).body.latestOrderId).toBe(order.publicId);
    await call(owner).post(`${customerBase}/messages/read`, { through: photo.body.id }).expect(201);
    expect((await call(owner).get(`${customerBase}/coordination`)).body.unread).toBe(0);

    const nextMark = await revise(owner, customerBase, randomUUID(), 'Уточняю').expect(201);
    expect(nextMark.body).toMatchObject({ id: photo.body.id, imageRevision: 3 });
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(1);
    await call(seller).post(`${staffBase}/messages/read`, { through: photo.body.id }).expect(201);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(0);
    expect(await db.orderChatMessage.count({ where: { orderId: order.id } })).toBe(messageCount);

    const text = await call(owner).post(`${customerBase}/messages`, { text: 'Спасибо' }).expect(201);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(1);
    await call(seller).post(`${staffBase}/messages/read`, { through: text.body.id }).expect(201);
    expect((await call(seller).get(`${staffBase}/coordination`)).body.unread).toBe(0);
  });

  it('chat cleanup respects active orders, seven-day operations, 90-day evidence and missing files', async () => {
    const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#facc15' } }).png().toBuffer();
    const upload = (base: string, evidence = false) => {
      let call = request(app.getHttpServer()).post(`/api${base}/messages/image`)
        .set('Cookie', owner).field('text', '');
      if (evidence) call = call.field('evidence', 'true');
      return call.attach('file', png, { filename: 'market.png', contentType: 'image/png' });
    };
    const cleanup = app.get(ChatCleanupService);
    const active = await create('PICKUP');
    const activePhoto = await upload(`/orders/${active.publicId}`).expect(201);
    const activeRow = await db.orderChatMessage.findUniqueOrThrow({ where: { id: activePhoto.body.id } });
    const activeFull = join(chatDirectory, activeRow.imageKey + '.full.webp');
    await utimes(activeFull, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));
    await cleanup.run(new Date(Date.now() + 100 * 86400000));
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: activeRow.id } })).imageKey).toBe(activeRow.imageKey);
    expect((await stat(activeFull)).isFile()).toBe(true);

    const completed = await create('PICKUP');
    const photo = await upload(`/orders/${completed.publicId}`).expect(201);
    await call(seller).post(`/staff/orders/${completed.id}/messages/read`, { through: photo.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/api/orders/${completed.publicId}/messages/${photo.body.id}/revisions`)
      .set('Cookie', owner).field('text', 'Отметка').field('requestId', randomUUID())
      .attach('file', png, { filename: 'marked.png', contentType: 'image/png' }).expect(201);
    expect((await call(seller).get(`/staff/orders/${completed.id}/coordination`)).body.unread).toBe(1);
    const row = await db.orderChatMessage.findUniqueOrThrow({ where: { id: photo.body.id } });
    const versions = await db.orderChatImageRevision.findMany({ where: { messageId: row.id }, orderBy: { version: 'asc' } });
    expect(versions).toHaveLength(2);
    expect(versions[0]!.imageKey).not.toBe(row.imageKey);
    const originalFull = join(chatDirectory, versions[0]!.imageKey + '.full.webp');
    const originalThumb = join(chatDirectory, versions[0]!.imageKey + '.thumb.webp');
    const old = new Date(Date.now() - 2 * 86400000);
    await utimes(originalFull, old, old);
    await utimes(originalThumb, old, old);
    await cleanup.sweepOrphans();
    expect((await stat(originalFull)).isFile()).toBe(true);
    expect((await stat(originalThumb)).isFile()).toBe(true);
    expect(row.imageRetention).toBe('OPERATIONAL');
    await db.order.update({ where: { id: completed.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await unlink(join(chatDirectory, row.imageKey + '.full.webp'));
    await cleanup.run(new Date(Date.now() + 8 * 86400000));
    expect(await db.orderChatMessage.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ imageKey: null });
    expect((await call(seller).get(`/staff/orders/${completed.id}/coordination`)).body.unread).toBe(0);
    expect(await db.orderChatImageRevision.count({ where: { messageId: row.id } })).toBe(0);
    for (const version of versions) for (const variant of ['full', 'thumb'])
      expect(await readFile(join(chatDirectory, `${version.imageKey}.${variant}.webp`)).catch(() => null)).toBeNull();
    await call(owner).get(`/orders/${completed.publicId}/messages/${row.id}/image`).expect(410);
    await call(owner).get(`/orders/${completed.publicId}/messages/${row.id}/thumbnail`).expect(410);
    const page = await call(owner).get(`/orders/${completed.publicId}/messages`).expect(200);
    expect(page.body.messages.find((entry: { id: number }) => entry.id === row.id)).toMatchObject({ image: true, imageExpired: true });
    expect((await cleanup.run(new Date(Date.now() + 8 * 86400000))).deleted).toBe(0);

    const canceled = await create('PICKUP');
    const canceledPhoto = await upload(`/orders/${canceled.publicId}`).expect(201);
    await db.order.update({ where: { id: canceled.id }, data: { status: 'CANCELED' } });
    await db.orderCancellation.create({ data: { orderId: canceled.id, fromStatus: 'NEW', canceledByRole: 'ADMIN' } });
    await cleanup.run(new Date(Date.now() + 8 * 86400000));
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: canceledPhoto.body.id } })).imageDeletedAt).not.toBeNull();

    const evidence = await create('PICKUP');
    const evidencePhoto = await upload(`/orders/${evidence.publicId}`, true).expect(201);
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: evidencePhoto.body.id } })).imageRetention).toBe('EVIDENCE');
    await db.order.update({ where: { id: evidence.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await cleanup.run(new Date(Date.now() + 8 * 86400000));
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: evidencePhoto.body.id } })).imageKey).not.toBeNull();
    await cleanup.run(new Date(Date.now() + 91 * 86400000));
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: evidencePhoto.body.id } })).imageDeletedAt).not.toBeNull();

    const issueOrder = await phase2Order(1200);
    const issue = await issueFor(issueOrder.id);
    const issuePhoto = await request(app.getHttpServer()).post(`/api/orders/${issueOrder.publicId}/messages/image`)
      .set('Cookie', owner).field('text', '').field('issueId', String(issue.id))
      .attach('file', png, { filename: 'issue.png', contentType: 'image/png' }).expect(201);
    expect(await db.orderChatMessage.findUniqueOrThrow({ where: { id: issuePhoto.body.id } }))
      .toMatchObject({ issueId: issue.id, imageRetention: 'EVIDENCE', imageExpiresAt: null });
    await cleanup.run(new Date(Date.now() + 91 * 86400000));
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: issuePhoto.body.id } })).imageKey).not.toBeNull();

    const received = await create('PICKUP');
    await db.order.update({ where: { id: received.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    const receivedPhoto = await upload(`/orders/${received.publicId}`).expect(201);
    expect((await db.orderChatMessage.findUniqueOrThrow({ where: { id: receivedPhoto.body.id } })).imageRetention).toBe('EVIDENCE');
  });

  it('orphan cleanup only removes old unreferenced chat files and staged uploads', async () => {
    const cleanup = app.get(ChatCleanupService);
    const old = new Date(Date.now() - 2 * 86400000);
    const orphan = join(chatDirectory, randomUUID() + '.full.webp');
    const fresh = join(chatDirectory, randomUUID() + '.thumb.webp');
    const unrelated = join(chatDirectory, 'product.webp');
    const incoming = join(chatDirectory, '.incoming', randomBytes(16).toString('hex'));
    for (const file of [orphan, fresh, unrelated, incoming]) await writeFile(file, 'fixture');
    for (const file of [orphan, unrelated, incoming]) await utimes(file, old, old);
    expect(await cleanup.sweepOrphans()).toBe(2);
    expect(await readFile(orphan).catch(() => null)).toBeNull();
    expect(await readFile(incoming).catch(() => null)).toBeNull();
    expect(await readFile(fresh, 'utf8')).toBe('fixture');
    expect(await readFile(unrelated, 'utf8')).toBe('fixture');
    await unlink(fresh);
    await unlink(unrelated);
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

  it('PHASE 2.1 extras are versioned, customer-visible during assembly and included in the one payment', async () => {
    const order = await phase2Order(1000);
    const path = `/staff/orders/${order.id}/extras`;
    const input = { title: 'Нарезка', comment: 'Помыть и нарезать', quantity: 1, unitPrice: 50000 };
    await call(owner).post(path, input).expect(403);
    await call('').post(path, input).expect(401);
    const extra = (await call(seller).post(path, input).expect(201)).body;
    expect(extra.amount).toBe(50000);
    expect(await db.orderIssue.count({ where: { orderId: order.id } })).toBe(0);
    expect((await call(owner).get(`/orders/${order.publicId}`)).body.extras).toMatchObject([{ title: 'Нарезка', amount: 50000 }]);
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
    await call('')
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

  it('settles 1.8 kg actual weight from immutable price/base snapshots and excludes NO_MARKUP', async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: productId } });
    const settingsBefore = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
    const checkout = async (qty: number) => {
      let basket = (await call(owner).get('/cart').expect(200)).body;
      basket = (await call(owner).post('/cart/change', { revision: basket.revision, kind: 'clear' }).expect(201)).body;
      basket = (await call(owner).post('/cart/change', { revision: basket.revision, kind: 'set', productId, qty }).expect(201)).body;
      const created = await call(owner).post('/cart/checkout', {
        revision: basket.revision, type: 'PICKUP', customerName: 'Покупатель',
        customerPhone: '+79990000103',
      }).expect(201);
      return created.body.order as { id: number; publicId: string };
    };
    try {
      await db.shopSettings.update({ where: { id: 1 }, data: { weightToleranceBps: 1000 } });
      await call(admin).patch(`/admin/products/${productId}`, {
        price: 45000, active: true, settlementMode: 'SHARED_MARKUP', basePrice: 30000,
      }).expect(200);
      const first = await checkout(2000);
      const oldItem = await db.orderItem.findFirstOrThrow({ where: { orderId: first.id } });
      expect(oldItem).toMatchObject({ price: 45000, settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 30000 });
      await assemble(first, 1800);
      await call(seller).post(`/staff/orders/${first.id}/assembly/finish`).expect(201);
      await call(seller).post(`/staff/orders/${first.id}/payment/confirm`).expect(201);
      await call(seller).post(`/staff/orders/${first.id}/pickup/complete`).expect(201);
      const finished = await db.order.findUniqueOrThrow({ where: { id: first.id }, include: { items: true } });
      expect(finished.completedAt).not.toBeNull();
      expect(finished.items[0]).toMatchObject({ actualQty: 1800, actualTotal: 81000 });
      await call(admin).patch(`/admin/products/${productId}`, { basePrice: 32000 }).expect(200);
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const day = (await call(admin).get(`/admin/finance/days/${date}`).expect(200)).body as {
        id: number; lines: { saleAmount: number; baseAmount: number; sharedMarkup: number }[];
        totals: { partner1Share: number; partner2Share: number };
      }[];
      expect(day.find(row => row.id === first.id)?.lines[0]).toMatchObject({
        saleAmount: 81000, baseAmount: 54000, sharedMarkup: 27000,
      });
      const next = await checkout(1000);
      expect(await db.orderItem.findFirstOrThrow({ where: { orderId: next.id } }))
        .toMatchObject({ settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 32000 });
      await call(admin).patch(`/admin/products/${productId}`, {
        settlementMode: 'NO_MARKUP', basePrice: 32000,
      }).expect(200);
      const excluded = await checkout(1000);
      expect(await db.orderItem.findFirstOrThrow({ where: { orderId: excluded.id } }))
        .toMatchObject({ settlementModeSnapshot: 'NO_MARKUP', basePriceSnapshot: null });
      await assemble(excluded, 1000);
      await call(seller).post(`/staff/orders/${excluded.id}/assembly/finish`).expect(201);
      await call(seller).post(`/staff/orders/${excluded.id}/payment/confirm`).expect(201);
      await call(seller).post(`/staff/orders/${excluded.id}/pickup/complete`).expect(201);
      const latest = (await call(admin).get(`/admin/finance/days/${date}`).expect(200)).body as {
        id: number; totals: { noMarkupRevenue: number; sharedMarkup: number };
      }[];
      expect(latest.find(row => row.id === excluded.id)?.totals)
        .toMatchObject({ noMarkupRevenue: 45000, sharedMarkup: 0 });
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: oldItem.id } })).basePriceSnapshot).toBe(30000);
    } finally {
      await db.product.update({ where: { id: productId }, data: {
        price: before.price, active: before.active,
        settlementMode: before.settlementMode, basePrice: before.basePrice,
      } });
      await db.shopSettings.update({ where: { id: 1 }, data: { weightToleranceBps: settingsBefore.weightToleranceBps } });
    }
  });

  it('ADMIN settlement is private; orders, cart, catalog and SELLER stay public-safe', async () => {
    await call(seller).patch(`/admin/products/${productId}`, { settlementMode: 'SHARED_MARKUP', basePrice: 30000 }).expect(403);
    const saved = await call(admin).patch(`/admin/products/${productId}`, {
      settlementMode: 'SHARED_MARKUP', basePrice: 30000,
    }).expect(200);
    expect(saved.body).toMatchObject({ settlementMode: 'SHARED_MARKUP', basePrice: 30000 });
    const adminList = await call(admin).get('/admin/products?settlementMode=SHARED_MARKUP').expect(200);
    expect(adminList.body.items.some((item: { id: number }) => item.id === productId)).toBe(true);
    const privateKeys = ['basePrice', 'settlementMode', 'basePriceSnapshot',
      'settlementModeSnapshot', 'sharedMarkup', 'partner1Share', 'partner2Share'];
    for (const body of [
      (await call(owner).get('/products/tomato').expect(200)).body,
      (await call(owner).get('/products').expect(200)).body,
      (await call(owner).get('/cart').expect(200)).body,
      (await call(owner).post('/orders/quote', { items: [{ productId, qty: 1000 }] }).expect(201)).body,
      (await call(owner).get('/orders').expect(200)).body,
      (await call(seller).get('/staff/orders').expect(200)).body,
    ]) for (const key of privateKeys) expect(JSON.stringify(body)).not.toContain(`"${key}"`);
    const order = await create('PICKUP');
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(item).toMatchObject({ settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 30000 });
    const customerOrder = await call(owner).get(`/orders/${order.publicId}`).expect(200);
    for (const key of privateKeys) expect(JSON.stringify(customerOrder.body)).not.toContain(`"${key}"`);
    const guestCreated = await call('').post('/orders', {
      type: 'PICKUP', customerName: 'Guest', customerPhone: '+79990000103',
      items: [{ productId, qty: 1000 }],
    }).expect(201);
    const guestItem = await db.orderItem.findFirstOrThrow({ where: { orderId: guestCreated.body.id } });
    expect(guestItem).toMatchObject({ settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 30000 });
    const guestCookie = (guestCreated.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    for (const body of [guestCreated.body,
      (await call(guestCookie).get('/orders').expect(200)).body,
      (await call(guestCookie).get(`/orders/${guestCreated.body.publicId}`).expect(200)).body,
    ]) for (const key of privateKeys) expect(JSON.stringify(body)).not.toContain(`"${key}"`);
    const staffOrder = await call(seller).get(`/staff/orders/${order.id}`).expect(200);
    for (const key of privateKeys) expect(JSON.stringify(staffOrder.body)).not.toContain(`"${key}"`);
    await call(seller).post('/staff/orders/' + order.id + '/confirm').expect(201);
    await call(seller).post('/staff/orders/' + order.id + '/assembly/start').expect(201);
    const changedItem = await call(seller).patch('/staff/orders/' + order.id + '/items/' + item.id, {
      status: 'PICKED', actualQty: item.qty,
    }).expect(200);
    for (const key of privateKeys) expect(JSON.stringify(changedItem.body)).not.toContain('"' + key + '"');
    const excluded = await call(admin).patch(`/admin/products/${productId}`, {
      settlementMode: 'NO_MARKUP', basePrice: 30000,
    }).expect(200);
    expect(excluded.body).toMatchObject({ settlementMode: 'NO_MARKUP', basePrice: null });
    const normalized = await call(admin).patch(`/admin/products/${productId}`, { basePrice: 30000 }).expect(200);
    expect(normalized.body.basePrice).toBeNull();
    await call(admin).patch(`/admin/products/${productId}`, { settlementMode: 'UNSET' }).expect(200);
    expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).basePrice).toBeNull();
  });

  it('ADMIN order detail selects existing chat fields through Prisma', async () => {
    const order = await create('PICKUP');
    const chat = await db.orderChatMessage.create({ data: {
      orderId: order.id, authorType: 'CUSTOMER', recipient: 'staff', text: 'Сообщение для проверки',
    } });
    const response = await call(admin).get(`/admin/orders/${order.id}`).expect(200);
    expect(response.body.id).toBe(order.id);
    expect(response.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: chat.id, text: chat.text, createdAt: expect.any(String) }),
    ]));
    expect(response.body.messages.find((message: { id: number }) => message.id === chat.id))
      .not.toHaveProperty('sender');
  });

  it('ADMIN schedule, report and payout endpoints reject SELLER and keep audit/idempotency', async () => {
    for (const path of ['/admin/finance', '/admin/payouts', '/admin/schedule',
      '/admin/orders', '/admin/dashboard']) await call(seller).get(path).expect(403);
    const safeStatus = await call(owner).get('/shop/status').expect(200);
    expect(Object.keys(safeStatus.body).sort()).toEqual([
      'closeTime', 'isOpen', 'nextOpenAt', 'openTime', 'timezone', 'today',
    ].sort());
    await call(admin).get('/admin/dashboard').expect(200);
    await call(admin).get('/admin/orders?limit=1&page=1').expect(200);
    await call(admin).get('/admin/finance?period=today').expect(200);
    const week = await call(admin).patch('/admin/schedule/weekly/1', {
      enabled: true, openMinutes: 540, closeMinutes: 1260,
    }).expect(200);
    expect(week.body).toMatchObject({ weekday: 1, openMinutes: 540, closeMinutes: 1260 });
    await call(admin).patch('/admin/schedule/weekly/1', { enabled: true, openMinutes: 0, closeMinutes: 1440 }).expect(200);
    const special = await call(admin).post('/admin/schedule/exceptions', {
      date: '2099-01-01', closed: true, openMinutes: null, closeMinutes: null, note: 'Тест',
    }).expect(201);
    await call(admin).patch(`/admin/schedule/exceptions/${special.body.id}`, {
      date: '2099-01-01', closed: false, openMinutes: 540, closeMinutes: 1020, note: 'Тест',
    }).expect(200);
    const duplicateDate = { date: '2099-01-02', closed: true,
      openMinutes: null, closeMinutes: null, note: null };
    const attempts = await Promise.all([
      call(admin).post('/admin/schedule/exceptions', duplicateDate),
      call(admin).post('/admin/schedule/exceptions', duplicateDate),
    ]);
    expect(attempts.map(result => result.status).sort()).toEqual([201, 409]);
    const createdException = attempts.find(result => result.status === 201)!.body.id;
    await request(app.getHttpServer()).delete(`/api/admin/schedule/exceptions/${createdException}`)
      .set('Cookie', admin).expect(200);
    await request(app.getHttpServer()).delete(`/api/admin/schedule/exceptions/${special.body.id}`)
      .set('Cookie', admin).expect(200);
    const idempotencyKey = randomUUID();
    const payout = { partner: 1, periodFrom: '2026-09-01', periodTo: '2026-09-07',
      amount: 1000, paidAt: new Date().toISOString(), comment: 'Тест', idempotencyKey };
    const first = await call(admin).post('/admin/payouts', payout).expect(201);
    const again = await call(admin).post('/admin/payouts', payout).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await db.partnerPayout.count({ where: { idempotencyKey } })).toBe(1);
    expect(await db.adminAudit.count({ where: { action: 'PARTNER_PAYOUT_RECORDED', entityId: String(first.body.id) } })).toBe(1);
    const duplicate = await call(admin).post('/admin/payouts', {
      ...payout, idempotencyKey: randomUUID(),
    }).expect(409);
    expect(duplicate.body.code).toBe('PAYOUT_DUPLICATE');
    expect(await db.partnerPayout.count({ where: { partner: 1, amount: 1000 } })).toBe(1);
    await call(admin).post('/admin/payouts', {
      ...payout, amount: -1000, idempotencyKey: randomUUID(),
    }).expect(201);
    const concurrent = { ...payout, periodFrom: '2099-02-01', periodTo: '2099-02-07' };
    const pair = await Promise.all([
      call(admin).post('/admin/payouts', { ...concurrent, idempotencyKey: randomUUID() }),
      call(admin).post('/admin/payouts', { ...concurrent, idempotencyKey: randomUUID() }),
    ]);
    expect(pair.map(response => response.status).sort()).toEqual([201, 409]);
    expect(await db.partnerPayout.count({ where: {
      partner: 1, amount: 1000,
      periodFrom: new Date('2099-02-01T00:00:00.000Z'),
      periodTo: new Date('2099-02-07T00:00:00.000Z'),
    } })).toBe(1);
    const sameKey = { ...payout, periodFrom: '2099-03-01', periodTo: '2099-03-07',
      idempotencyKey: randomUUID() };
    const repeated = await Promise.all([
      call(admin).post('/admin/payouts', sameKey),
      call(admin).post('/admin/payouts', sameKey),
    ]);
    expect(repeated.map(response => response.status)).toEqual([201, 201]);
    expect(repeated[0]?.body.id).toBe(repeated[1]?.body.id);
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
