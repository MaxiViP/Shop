import { ServiceFeeCtrl } from '../src/admin/service-fee.ctrl.js';
import { ServiceFeeService } from '../src/admin/service-fee.service.js';
import {
  readBulkPreview,
  signBulkPreview,
} from '../src/admin/service-fee-token.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { SettingsCtrl } from '../src/admin/settings.ctrl.js';
import { SettingsService } from '../src/admin/settings.service.js';
import { OwnerCtrl } from '../src/admin/owner.ctrl.js';
import { ImagesService } from '../src/admin/images.service.js';
import { CartService } from '../src/cart/cart.service.js';
import { OrderService } from '../src/order/order.service.js';
import { ProductService } from '../src/product/product.service.js';
import { customerPrice } from '../src/product/pricing.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';

const target = process.env.SERVICE_FEE_TEST_DATABASE_URL;
const schema = `fee_bulk_${randomUUID().replaceAll('-', '')}`;
const adminPhone = '+79990000887';

describe.skipIf(!target)('safe bulk service fee / dedicated PostgreSQL', () => {
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>;
  let created = false,
    adminId: number,
    buyerId: number,
    ownerId: number,
    categoryId: number,
    pointId: number;
  let products: AdminProductsService,
    settings: SettingsService,
    orders: OrderService,
    cart: CartService;
  let historical: unknown;
  const http = () => request(app.getHttpServer());
  const cookie = (role = 'ADMIN') => `${SID}=${role}`;
  const body = (extra: Record<string, unknown> = {}) => ({
    name: 'Fee product',
    slug: `fee-${randomUUID()}`,
    description: null,
    price: 10005,
    priceQty: 1,
    unit: 'PIECE',
    min: 1,
    step: 1,
    portionQty: 1,
    categoryId,
    sort: 0,
    active: true,
    ...extra,
  });
  const global = (percent: number) =>
    http()
      .patch('/api/admin/settings')
      .set('Cookie', cookie())
      .send({ globalServiceMarkupPercent: percent });
  const create = async (extra: Record<string, unknown> = {}) =>
    (
      await http()
        .post('/api/admin/products')
        .set('Cookie', cookie())
        .send(body(extra))
        .expect(201)
    ).body as {
      id: number;
      price: number;
      serviceMarkupPercent: number;
      serviceMarkupPercentOverride: number | null;
      customerPrice: number;
    };

  beforeAll(async () => {
    const url = new URL(target!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/service_fee_test_[a-f0-9]{32}$/.test(url.pathname)
    )
      throw new Error('Dedicated local test database required');
    if (!/^fee_bulk_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unsafe test schema');
    connection = new pg.Client({ connectionString: target });
    await connection.connect();
    await connection.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true }))
      .filter((row) => row.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20261103150000_global_service_fee') {
        await connection.query(`
          INSERT INTO "Category" (id,name,slug,"updatedAt") VALUES (-1,'Legacy','fee-legacy',NOW());
          INSERT INTO "Product" (id,name,slug,price,unit,"portionQty","categoryId","updatedAt")
          SELECT id,'Legacy '||id,'fee-legacy-'||id,10000+id,'PIECE',1,-1,'2026-10-20' FROM generate_series(1,173) id;
          INSERT INTO "Order" (id,type,status,"customerName","customerPhone",subtotal,"deliveryPrice",total,"finalSubtotal","finalTotal","updatedAt")
          VALUES (-1,'PICKUP','COMPLETED','Historical','+79990000000',11000,0,11000,11000,11000,'2026-10-20');
          INSERT INTO "OrderItem" (id,"productName","productSlug",price,"priceQty",unit,qty,total,"orderId","productId","serviceMarkupPercentSnapshot")
          VALUES (-1,'Historical','historical',11000,1,'PIECE',1,11000,-1,1,NULL);
          INSERT INTO "OrderPayment" (id,"orderId",amount,status,"updatedAt") VALUES (-1,-1,11000,'PAID','2026-10-20');
        `);
      }
      await connection.query(
        await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
      );
    }
    await connection.query(
      `SELECT setval(pg_get_serial_sequence('"Product"','id'),173)`,
    );
    db = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: target, options: `-c search_path=${schema}` },
        { schema },
      ),
    });
    historical = await history();
    adminId = (
      await db.user.create({ data: { role: 'ADMIN', phone: adminPhone } })
    ).id;
    buyerId = (
      await db.user.create({ data: { role: 'USER', phone: '+79990000002' } })
    ).id;
    ownerId = (
      await db.user.create({ data: { role: 'USER', phone: '+79990000003' } })
    ).id;
    categoryId = (
      await db.category.create({
        data: { name: 'Fee fixtures', slug: 'fee-fixtures' },
      })
    ).id;
    pointId = (await db.marketPoint.findFirstOrThrow()).id;
    await db.marketPointOwner.create({
      data: { userId: ownerId, marketPointId: pointId },
    });
    vi.stubEnv('ADMIN_PHONE', adminPhone);
    const database = db as unknown as DbService;
    const images = new ImagesService(database);
    products = new AdminProductsService(database, images);
    settings = new SettingsService(database);
    orders = new OrderService(database, {
      notifyNewOrder: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramService);
    cart = new CartService(database, orders);
    const module = await Test.createTestingModule({
      controllers: [ServiceFeeCtrl, AdminProductsCtrl, SettingsCtrl, OwnerCtrl],
      providers: [
        {
          provide: ServiceFeeService,
          useValue: new ServiceFeeService(database),
        },
        { provide: DbService, useValue: database },
        { provide: AdminProductsService, useValue: products },
        { provide: SettingsService, useValue: settings },
        { provide: ImagesService, useValue: images },
        {
          provide: AuthService,
          useValue: {
            me: async (token?: string) => {
              const id =
                token === 'ADMIN'
                  ? adminId
                  : token === 'OWNER'
                    ? ownerId
                    : token === 'USER'
                      ? buyerId
                      : null;
              if (id)
                return db.user.findUnique({
                  where: { id },
                  include: { ownedPoints: { select: { marketPointId: true } } },
                });
              return token === 'SELLER' || token === 'OTHER_ADMIN'
                ? {
                    id: buyerId,
                    role: token === 'SELLER' ? 'SELLER' : 'ADMIN',
                    phone: '+79990000002',
                  }
                : null;
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>({
      logger: false,
    });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    await db.shopHours.updateMany({
      data: { enabled: true, openMinutes: 0, closeMinutes: 1440 },
    });
  }, 60000);

  beforeEach(async () => {
    await db.serviceFeeBulkOperation.deleteMany();
    await db.order.deleteMany({ where: { id: { gt: 0 } } });
    await db.cartItem.deleteMany();
    await db.cart.deleteMany();
    await db.product.deleteMany({ where: { id: { gt: 173 } } });
    await db.product.updateMany({
      where: { id: { lte: 173 } },
      data: {
        serviceMarkupPercentOverride: 10,
        serviceMarkupPercent: 10,
        serviceMarkupNeedsReview: true,
      },
    });
    await db.$executeRaw`UPDATE "Product" SET price=10000+id,"priceQty"=1,name='Legacy '||id WHERE id BETWEEN 1 AND 173`;
    await db.shopSettings.update({
      where: { id: 1 },
      data: { globalServiceMarkupPercent: 10 },
    });
    await db.adminAudit.deleteMany();
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (created && /^fee_bulk_[a-f0-9]{32}$/.test(schema))
      await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end();
    vi.unstubAllEnvs();
  });

  async function history() {
    return {
      orders: await db.order.findMany({ where: { id: -1 } }),
      items: await db.orderItem.findMany({ where: { orderId: -1 } }),
      payments: await db.orderPayment.findMany({ where: { orderId: -1 } }),
    };
  }

  type Preview = Awaited<ReturnType<ServiceFeeService['preview']>>;
  const ids = (n = 1) => ({
    kind: 'ids' as const,
    ids: Array.from({ length: n }, (_, i) => i + 1),
  });
  const preview = async (
    selection: Parameters<ServiceFeeService['preview']>[0]['selection'] = ids(),
  ) =>
    (
      await http()
        .post('/api/admin/products/service-fee/bulk/preview')
        .set('Cookie', cookie())
        .send({ selection, mode: 'global' })
        .expect(201)
    ).body as Preview;
  const apply = (p: Preview, requestId = randomUUID(), role = 'ADMIN') =>
    http()
      .post('/api/admin/products/service-fee/bulk/apply')
      .set('Cookie', cookie(role))
      .send({ previewToken: p.previewToken, requestId, confirmed: true });
  const get = (id = 1) => db.product.findUniqueOrThrow({ where: { id } });
  const historyUnchanged = async () =>
    expect(await history()).toEqual(historical);

  it('preview is read-only, signed, server-calculated and does not clear review', async () => {
    await global(15).expect(200);
    const before = await db.product.findMany({ orderBy: { id: 'asc' } }),
      audits = await db.adminAudit.count();
    const p = await preview();
    expect(p).toMatchObject({ count: 1, changedCount: 1, globalPercent: 15 });
    expect(p.rows[0]).toMatchObject({
      id: 1,
      before: {
        mode: 'individual',
        override: 10,
        percent: 10,
        needsReview: true,
        customerPrice: customerPrice(10001, 10),
      },
      after: {
        mode: 'global',
        override: null,
        percent: 15,
        needsReview: false,
        customerPrice: customerPrice(10001, 15),
      },
    });
    expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await db.adminAudit.count()).toBe(audits);
    expect(await db.serviceFeeBulkOperation.count()).toBe(0);
    await historyUnchanged();
  });
  it.each([1, 10, 173])(
    'atomically translates %i migrated exceptions and records every old percentage',
    async (count) => {
      await global(15).expect(200);
      const p = await preview(ids(count));
      const requestId = randomUUID();
      const r = await apply(p, requestId).expect(201);
      expect(r.body).toMatchObject({
        requestId,
        count,
        changedCount: count,
        skippedCount: 0,
        globalPercent: 15,
      });
      expect(
        await db.product.count({
          where: {
            id: { lte: count },
            serviceMarkupPercentOverride: null,
            serviceMarkupPercent: 15,
            serviceMarkupNeedsReview: false,
          },
        }),
      ).toBe(count);
      expect(
        await db.product.count({
          where: {
            serviceMarkupPercentOverride: 10,
            serviceMarkupNeedsReview: true,
          },
        }),
      ).toBe(173 - count);
      const audit = await db.adminAudit.findMany({
        where: { action: 'PRODUCT_MARKUP_CHANGED' },
      });
      expect(audit).toHaveLength(count);
      expect(
        audit.every(
          (a) =>
            (a.oldValue as { serviceMarkupPercentOverride: number })
              .serviceMarkupPercentOverride === 10 &&
            (a.newValue as { requestId: string }).requestId === requestId,
        ),
      ).toBe(true);
      const product = await get();
      expect(product.normalizedPrice.toNumber()).toBe(
        customerPrice(product.price, 15),
      );
      await historyUnchanged();
    },
  );
  it('selects all 173 review rows, excluding an intentional 0% and other confirmed settings', async () => {
    const zero = await create({ serviceMarkupPercentOverride: 0 });
    await create({ serviceMarkupPercentOverride: 20 });
    await global(15).expect(200);
    const p = await preview({
      kind: 'filter',
      filter: { serviceFeeMode: 'review' },
    });
    expect(p.count).toBe(173);
    await apply(p).expect(201);
    expect((await get(zero.id)).serviceMarkupPercentOverride).toBe(0);
    expect(
      await db.product.count({ where: { serviceMarkupNeedsReview: true } }),
    ).toBe(0);
    await historyUnchanged();
  });
  it('handles explicit individual zero, price decreases and same-number mode changes', async () => {
    const zero = await create({ serviceMarkupPercentOverride: 0 });
    await global(15).expect(200);
    const p = await preview({ kind: 'ids', ids: [zero.id] });
    expect(p.rows[0].before.percent).toBe(0);
    expect(p.rows[0].after.customerPrice).toBe(customerPrice(10005, 15));
    await apply(p).expect(201);
    await global(0).expect(200);
    const down = await preview();
    expect(down.rows[0].difference).toBeLessThan(0);
    expect(down.rows[0].differenceBps).toBeLessThan(0);
    await global(10).expect(200);
    const same = await preview();
    expect(same.rows[0].difference).toBe(0);
    expect(same.changedCount).toBe(1);
    await apply(same).expect(201);
  });
  it('uses the same filters before list count/pagination and before preview selection', async () => {
    await create({ name: 'Search fixture A' });
    await create({ name: 'Search fixture B' });
    await create({ name: 'Search fixture C', serviceMarkupPercentOverride: 0 });
    const url = '/api/admin/products';
    const a = await http()
      .get(url)
      .set('Cookie', cookie())
      .query({ serviceFeeMode: 'review', page: 1, limit: 10 })
      .expect(200);
    const b = await http()
      .get(url)
      .set('Cookie', cookie())
      .query({ serviceFeeMode: 'review', page: 2, limit: 10 })
      .expect(200);
    expect(a.body.total).toBe(173);
    expect(a.body.pages).toBe(18);
    expect(b.body.total).toBe(173);
    expect(
      new Set(
        [...a.body.items, ...b.body.items].map((r: { id: number }) => r.id),
      ).size,
    ).toBe(20);
    const filter = {
      search: 'Search fixture',
      category: categoryId,
      active: 'true' as const,
      serviceFeeMode: 'individual' as const,
    };
    const found = await http()
      .get(url)
      .set('Cookie', cookie())
      .query({ ...filter, limit: 1, page: 1 })
      .expect(200);
    expect(found.body.total).toBe(1);
    expect((await preview({ kind: 'filter', filter })).count).toBe(1);
    const common = await http()
      .get(url)
      .set('Cookie', cookie())
      .query({ serviceFeeMode: 'global' })
      .expect(200);
    expect(common.body.total).toBe(2);
    const individual = await http()
      .get(url)
      .set('Cookie', cookie())
      .query({ serviceFeeMode: 'individual' })
      .expect(200);
    expect(individual.body.total).toBe(174);
  });
  it('selects a complete search result, not only the visible page', async () => {
    for (let i = 0; i < 12; i++)
      await create({
        name: 'Filtered target ' + i,
        serviceMarkupPercentOverride: 20,
      });
    const p = await preview({
      kind: 'filter',
      filter: { search: 'Filtered target', category: categoryId },
    });
    expect(p.count).toBe(12);
    await apply(p).expect(201);
    expect(
      await db.product.count({
        where: {
          name: { startsWith: 'Filtered target' },
          serviceMarkupPercentOverride: null,
        },
      }),
    ).toBe(12);
  });
  it.each([
    'global',
    'price',
    'mode',
    'review',
    'name',
    'quantity',
    'membership',
  ] as const)('rejects stale preview after %s changes', async (change) => {
    const p = await preview(
      change === 'membership'
        ? { kind: 'filter', filter: { serviceFeeMode: 'review' } }
        : ids(),
    );
    if (change === 'global') await global(15).expect(200);
    if (change === 'price') await products.update(1, { price: 20000 }, adminId);
    if (change === 'mode')
      await products.update(1, { serviceMarkupPercentOverride: 0 }, adminId);
    if (change === 'review')
      await products.update(1, { serviceMarkupPercentOverride: 10 }, adminId);
    if (change === 'name')
      await products.update(1, { name: 'Renamed' }, adminId);
    if (change === 'quantity')
      await db.product.update({ where: { id: 1 }, data: { priceQty: 2 } });
    if (change === 'membership')
      await db.product.update({
        where: { id: 2 },
        data: { serviceMarkupNeedsReview: false },
      });
    const before = await db.product.findMany({ orderBy: { id: 'asc' } }),
      audits = await db.adminAudit.count();
    await apply(p).expect(409);
    expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await db.adminAudit.count()).toBe(audits);
    expect(await db.serviceFeeBulkOperation.count()).toBe(0);
  });
  it('rejects forged, expired, unconfirmed and price-bearing requests', async () => {
    const p = await preview();
    await apply({ ...p, previewToken: p.previewToken + 'x' }).expect(409);
    await apply({
      ...p,
      previewToken: signBulkPreview({
        ...readBulkPreview(p.previewToken),
        expiresAt: Date.now() - 1,
      }),
    }).expect(409);
    for (const extra of [
      { confirmed: false },
      { confirmed: undefined },
      { prices: [1] },
      { serviceMarkupPercent: 15 },
    ]) {
      await http()
        .post('/api/admin/products/service-fee/bulk/apply')
        .set('Cookie', cookie())
        .send({
          previewToken: p.previewToken,
          requestId: randomUUID(),
          confirmed: true,
          ...extra,
        })
        .expect(400);
    }
    await http()
      .post('/api/admin/products/service-fee/bulk/preview')
      .set('Cookie', cookie())
      .send({ selection: ids(), mode: 'global', price: 1 })
      .expect(400);
    expect((await get()).serviceMarkupPercentOverride).toBe(10);
  });
  it('replays a committed request across new state/key rotation without duplicate audits', async () => {
    const p = await preview(ids(10)),
      requestId = randomUUID();
    const result = (await apply(p, requestId).expect(201)).body;
    const count = await db.adminAudit.count();
    await global(15).expect(200);
    const afterGlobal = await db.adminAudit.count();
    vi.stubEnv(
      'SERVICE_FEE_PREVIEW_SECRET',
      'rotated-test-key-000000000000000000000000',
    );
    try {
      expect((await apply(p, requestId).expect(201)).body).toEqual(result);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv('ADMIN_PHONE', adminPhone);
    }
    expect(await db.adminAudit.count()).toBe(afterGlobal);
    expect(afterGlobal).toBeGreaterThan(count);
    expect(await db.serviceFeeBulkOperation.count()).toBe(1);
    const newer = await preview();
    await apply(newer, requestId).expect(409);
    await apply(p, randomUUID()).expect(409);
  });
  it('serializes two admin sessions using the same requestId', async () => {
    const p = await preview(ids(10)),
      key = randomUUID();
    const r = await Promise.all([apply(p, key), apply(p, key)]);
    expect(r.some((row) => row.status === 201)).toBe(true);
    expect(r.every((row) => [201, 409].includes(row.status))).toBe(true);
    const replay = await apply(p, key).expect(201);
    expect(replay.body.changedCount).toBe(10);
    expect(await db.serviceFeeBulkOperation.count()).toBe(1);
    expect(
      await db.adminAudit.count({
        where: { action: 'PRODUCT_MARKUP_CHANGED' },
      }),
    ).toBe(10);
  });
  it('conflicts two admin sessions applying different operations to the same products', async () => {
    const p = await preview(ids(10));
    const r = await Promise.all([apply(p), apply(p)]);
    expect(r.map((row) => row.status).sort()).toEqual([201, 409]);
    expect(await db.serviceFeeBulkOperation.count()).toBe(1);
    expect(
      await db.adminAudit.count({
        where: { action: 'PRODUCT_MARKUP_CHANGED' },
      }),
    ).toBe(10);
  });
  async function hold(
    lock: 'Product' | 'ShopSettings',
    work: () => Promise<void>,
  ) {
    let release: () => void = () => {},
      ready: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
      }),
      locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
    const tx = db.$transaction(
      async (conn) => {
        if (lock === 'Product')
          await conn.$queryRaw`SELECT id FROM "Product" WHERE id=1 FOR SHARE`;
        else
          await conn.$queryRaw`SELECT id FROM "ShopSettings" WHERE id=1 FOR UPDATE`;
        ready();
        await waiting;
      },
      { timeout: 10000 },
    );
    await locked;
    try {
      await work();
    } finally {
      release();
      await tx;
    }
  }
  it.each(['Product', 'ShopSettings'] as const)(
    'fails fast without partial writes while %s is occupied',
    async (lock) => {
      const p = await preview(ids(10));
      await hold(lock, async () => {
        await apply(p).expect(409);
      });
      expect(
        await db.product.count({ where: { serviceMarkupPercentOverride: 10 } }),
      ).toBe(173);
      expect(await db.serviceFeeBulkOperation.count()).toBe(0);
      await apply(p).expect(201);
    },
  );
  it('races global updates without mixing effective percentages or SQL generated prices', async () => {
    const p = await preview(ids(10));
    const r = await Promise.all([apply(p), global(15)]);
    expect([201, 409]).toContain(r[0].status);
    expect([200, 409]).toContain(r[1].status);
    const settings = await db.shopSettings.findUniqueOrThrow({
      where: { id: 1 },
    });
    for (const row of await db.product.findMany({
      where: { id: { lte: 10 } },
    })) {
      expect(row.serviceMarkupPercent).toBe(
        row.serviceMarkupPercentOverride ?? settings.globalServiceMarkupPercent,
      );
      expect(row.normalizedPrice.toNumber()).toBe(
        customerPrice(row.price, row.serviceMarkupPercent),
      );
    }
    await historyUnchanged();
  });
  it('races actual cart and guest checkout without mixed-price order snapshots', async () => {
    await global(15).expect(200);
    const p = await preview(ids(10));
    const basket = await cart.get(buyerId);
    const filled = await cart.change(buyerId, basket.revision, {
      kind: 'set',
      productId: 1,
      qty: 2,
    });
    const [checkout, response] = await Promise.all([
      cart.checkout(buyerId, filled.revision, {
        type: 'PICKUP',
        customerName: 'Buyer',
        customerPhone: '+79990000002',
        checkoutRequestId: randomUUID(),
      }),
      apply(p),
    ]);
    expect([201, 409]).toContain(response.status);
    const item = await db.orderItem.findFirstOrThrow({
      where: { orderId: checkout.order.id },
    });
    expect(item.price).toBe(
      customerPrice(10001, item.serviceMarkupPercentSnapshot!),
    );
    expect(item.total).toBe(item.price * 2);
    const next = await preview({ kind: 'ids', ids: [11] });
    const [guest, changed] = await Promise.all([
      orders.create(null, undefined, {
        type: 'PICKUP',
        customerName: 'Guest',
        customerPhone: '+79990000004',
        items: [{ productId: 11, qty: 1 }],
        checkoutRequestId: randomUUID(),
      }),
      apply(next),
    ]);
    expect([201, 409]).toContain(changed.status);
    const line = await db.orderItem.findFirstOrThrow({
      where: { orderId: guest.order.id },
    });
    expect(line.price).toBe(
      customerPrice(10011, line.serviceMarkupPercentSnapshot!),
    );
    await historyUnchanged();
  });
  it.each(['AdminAudit', 'ServiceFeeBulkOperation'] as const)(
    'rolls back products, audit and result after a mid-transaction %s failure',
    async (table) => {
      const p = await preview(ids(10));
      const before = await db.product.findMany({ orderBy: { id: 'asc' } });
      await connection.query(`CREATE FUNCTION bulk_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic bulk failure'; END $$;
      CREATE TRIGGER bulk_failure BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION bulk_failure()`);
      try {
        await apply(p).expect(500);
      } finally {
        await connection.query(
          `DROP TRIGGER bulk_failure ON "${table}"; DROP FUNCTION bulk_failure()`,
        );
      }
      expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual(
        before,
      );
      expect(
        await db.adminAudit.count({
          where: { action: 'PRODUCT_MARKUP_CHANGED' },
        }),
      ).toBe(0);
      expect(await db.serviceFeeBulkOperation.count()).toBe(0);
      await apply(p).expect(201);
      await historyUnchanged();
    },
  );
  it('keeps public SQL price sorting correct after bulk', async () => {
    await global(15).expect(200);
    await apply(await preview(ids(10))).expect(201);
    const catalog = new ProductService(db as unknown as DbService);
    const page = await catalog.list({
      ids: Array.from({ length: 20 }, (_, i) => i + 1),
      feed: 'catalog',
      page: 1,
      limit: 100,
      sort: 'price_asc',
    });
    const prices = page.items.map((row) => row.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(page.items[0].id).toBe(11);
    const rows = await db.product.findMany({ where: { id: { lte: 20 } } });
    for (const row of rows)
      expect(row.normalizedPrice.toNumber()).toBe(
        customerPrice(row.price, row.serviceMarkupPercent),
      );
  });
  it.each(['USER', 'SELLER', 'OWNER', 'OTHER_ADMIN'])(
    'rejects %s at preview and apply routes',
    async (role) => {
      const p = await preview();
      await http()
        .post('/api/admin/products/service-fee/bulk/preview')
        .set('Cookie', cookie(role))
        .send({ selection: ids(), mode: 'global' })
        .expect(403);
      await apply(p, randomUUID(), role).expect(403);
      expect(await db.serviceFeeBulkOperation.count()).toBe(0);
    },
  );
});
