// Test-only executable. Never imported by the production application.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { DbService } from '../../src/db/db.service.js';
import { DbModule } from '../../src/db/db.module.js';
import { OtpCodeGuard, OtpLoginGuard } from '../../src/auth/otp.guard.js';
import { OrderModule } from '../../src/order/order.module.js';
import { CartModule } from '../../src/cart/cart.module.js';
import { ProductModule } from '../../src/product/product.module.js';
import { CategoryModule } from '../../src/category/category.module.js';
import { AddressModule } from '../../src/address/address.module.js';
import { OrderPhoneModule } from '../../src/order-phone/order-phone.module.js';
import { FavoriteModule } from '../../src/favorite/favorite.module.js';
import { PromoModule } from '../../src/promo/promo.module.js';
import { PublicSettingsCtrl } from '../../src/admin/settings.ctrl.js';
import { ShopStatusCtrl } from '../../src/admin/schedule.ctrl.js';
import { SettingsService } from '../../src/admin/settings.service.js';
import { ScheduleService } from '../../src/admin/schedule.service.js';
import { NotificationService } from '../../src/order/notification.service.js';
import { TelegramService } from '../../src/telegram/telegram.service.js';
import { moscowDay } from '../../src/admin/shop-hours.js';

const bootstrapUrl = new URL(process.env.E2E_DATABASE_URL ?? '');
assert.equal(bootstrapUrl.protocol, 'postgresql:');
assert.equal(bootstrapUrl.hostname, '127.0.0.1', 'Only explicit loopback PostgreSQL is allowed');
assert.equal(bootstrapUrl.pathname, '/checkout_e2e', 'A dedicated test bootstrap database is required');
assert.equal(bootstrapUrl.search, '', 'Connection options cannot redirect the database');
assert.equal(process.env.NODE_ENV, 'test');
const database = 'checkout_e2e_' + randomUUID().replaceAll('-', '');
assert.match(database, /^checkout_e2e_[a-f0-9]{32}$/);
const token = randomBytes(32).toString('hex');
const admin = new pg.Client({ connectionString: bootstrapUrl.href });
await admin.connect();
await admin.query(`CREATE DATABASE "${database}"`);
const url = new URL(bootstrapUrl);
url.pathname = '/' + database;
const connection = new pg.Client({ connectionString: url.href });
let db: PrismaClient | undefined;
let app: NestExpressApplication | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await app?.close();
    await db?.$disconnect();
    await connection.end();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
process.once('SIGTERM', () => { void close().then(() => process.exit()); });
process.once('SIGINT', () => { void close().then(() => process.exit()); });

try {
  await connection.connect();
  const migrations = resolve('prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    await connection.query(await readFile(resolve(migrations, entry.name, 'migration.sql'), 'utf8'));
  }
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
  const fixtureDb = db;
  const module = await Test.createTestingModule({
    imports: [DbModule, OrderModule, CartModule, ProductModule, CategoryModule, AddressModule,
      OrderPhoneModule, FavoriteModule, PromoModule],
    controllers: [PublicSettingsCtrl, ShopStatusCtrl],
    providers: [SettingsService, ScheduleService],
  }).overrideProvider(DbService).useValue(db)
    // Rate limiting is covered separately; the matrix logs in repeatedly from loopback.
    .overrideGuard(OtpCodeGuard).useValue({ canActivate: () => true })
    .overrideGuard(OtpLoginGuard).useValue({ canActivate: () => true })
    // Outbound delivery and background notification sweeps are outside checkout scope.
    .overrideProvider(TelegramService).useValue({ notifyNewOrder: async () => {} })
    .overrideProvider(NotificationService).useValue({ dispatch: async () => {}, dispatchTelegram: async () => {} })
    .compile();
  app = module.createNestApplication<NestExpressApplication>();
  app.use(cookieParser());
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: /^http:\/\/127\.0\.0\.1:\d+$/, credentials: true });
  let productId = 0;
  // Control API exists only in this executable, protected by a random run token.
  app.use('/__test', (req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-e2e-token'] !== token) { res.sendStatus(403); return; }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      if (req.method === 'POST' && req.path === '/reset') {
        // This connection can only point at our newly-created per-run database.
        const tables = await connection.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        );
        for (const { tablename } of tables.rows) assert.match(tablename, /^[A-Za-z_][A-Za-z0-9_]*$/);
        await connection.query('TRUNCATE ' + tables.rows.map(row => '"' + row.tablename + '"').join(',') + ' RESTART IDENTITY CASCADE');
        await fixtureDb.shopSettings.create({ data: { id: 1, minDeliverySubtotal: 0,
          freeDeliveryEnabled: true, freeDeliveryThreshold: 10000,
          queueThreshold: 1, slotCapacity: 1 } });
        // All-day calendar removes wall-clock opening-hour flakiness.
        await fixtureDb.shopHours.createMany({ data: Array.from({ length: 7 }, (_, weekday) =>
          ({ weekday: weekday + 1, openMinutes: 0, closeMinutes: 1440 })) });
        if (body.preorder === true) {
          const day = moscowDay(new Date());
          await fixtureDb.shopHoursException.create({ data: { date: new Date(day + 'T00:00:00Z'), closed: true } });
        }
        const category = await fixtureDb.category.create({ data: { name: 'E2E продукты', slug: 'e2e' } });
        const product = await fixtureDb.product.create({ data: { categoryId: category.id,
          name: 'E2E яблоки', slug: 'e2e-apples', price: 10000, priceQty: 1000,
          min: 1000, step: 100, portionQty: 1000, unit: 'GRAM', saleModel: 'WEIGHT_LOOSE',
          priceUnit: 'GRAM', priceStatus: 'AUDITED' } });
        productId = product.id;
        res.json({ productId });
      } else if (req.method === 'POST' && req.path === '/product') {
        assert.ok(body.price === undefined || (Number.isSafeInteger(body.price) && Number(body.price) > 0));
        assert.ok(body.active === undefined || typeof body.active === 'boolean');
        await fixtureDb.product.update({ where: { id: productId }, data: {
          ...(typeof body.price === 'number' ? { price: body.price } : {}),
          ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
        } });
        res.json({ ok: true });
      } else if (req.method === 'POST' && req.path === '/occupy') {
        assert.equal(typeof body.at, 'string');
        const at = new Date(String(body.at));
        assert.ok(Number.isFinite(at.getTime()));
        await fixtureDb.order.create({ data: { type: 'PICKUP', fulfillmentMode: 'SCHEDULED',
          scheduledFor: at, customerName: 'E2E slot blocker', customerPhone: '+79990000002', subtotal: 0 } });
        res.json({ ok: true });
      } else if (req.method === 'GET' && req.path === '/state') {
        res.json({ orders: await fixtureDb.order.findMany({ include: { items: true } }),
          carts: await fixtureDb.cart.findMany({ include: { items: true } }),
          users: await fixtureDb.user.findMany({ select: { id: true, phone: true } }) });
      } else res.sendStatus(404);
    })().catch(next);
  });
  await app.listen(0, '127.0.0.1');
  console.log('__CHECKOUT_READY__' + JSON.stringify({ apiBase: (await app.getUrl()) + '/api', token }));
} catch (error) {
  await close();
  throw error;
}
