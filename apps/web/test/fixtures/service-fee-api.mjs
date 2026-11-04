// Dedicated local test fixture: real compiled controllers/services/guards, synthetic sessions.
// Build API first. Never starts AppModule, background jobs or external integrations.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../../api/package.json', import.meta.url));
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { StandardSchemaValidationPipe } = require('@nestjs/common');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');
const cookieParser = require('cookie-parser');
const load = file => import(new URL('../../../api/dist/' + file + '.js', import.meta.url));

export async function serviceFeeApi() {
  const target = new URL(process.env.SERVICE_FEE_TEST_DATABASE_URL ?? '');
  assert.equal(target.protocol, 'postgresql:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /^\/service_fee_test_[a-f0-9]{32}$/);
  assert.equal(target.search, '', 'No database redirection options');
  const schema = 'fee_ui_' + randomUUID().replaceAll('-', '');
  const connection = new pg.Client({ connectionString: target.href });
  await connection.connect();
  await connection.query(`CREATE SCHEMA "${schema}"`);
  let db, app;
  const close = async () => {
    await app?.close(); await db?.$disconnect();
    assert.match(schema, /^fee_ui_[a-f0-9]{32}$/);
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`); await connection.end();
  };
  try {
    await connection.query(`SET search_path TO "${schema}"`);
    const root = new URL('../../../api/prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20261103150000_global_service_fee') {
        await connection.query(`
          INSERT INTO "Category" (name,slug,"updatedAt") VALUES ('Сервисные проценты','fee-ui',NOW());
          INSERT INTO "Product" (name,slug,price,unit,"portionQty","categoryId","updatedAt")
          SELECT 'Перенесённый товар '||id,'fee-ui-'||id,10000,'PIECE',1,(SELECT id FROM "Category" WHERE slug='fee-ui'),NOW() FROM generate_series(1,173) id;
          INSERT INTO "Order" (id,type,status,"customerName","customerPhone",subtotal,"deliveryPrice",total,"finalSubtotal","finalTotal","updatedAt")
          VALUES (-1,'PICKUP','COMPLETED','Historical','+79990000000',11000,0,11000,11000,11000,'2026-10-20');
          INSERT INTO "OrderItem" (id,"productName","productSlug",price,"priceQty",unit,qty,total,"orderId","productId","serviceMarkupPercentSnapshot")
          VALUES (-1,'Historical','historical',11000,1,'PIECE',1,11000,-1,1,NULL);
          INSERT INTO "OrderPayment" (id,"orderId",amount,status,"updatedAt") VALUES (-1,-1,11000,'PAID','2026-10-20');
        `);
      }
      await connection.query(await readFile(new URL(entry.name + '/migration.sql', root), 'utf8'));
    }
    const { PrismaClient } = await load('db/gen/client');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.href, options: `-c search_path=${schema}` }, { schema }) });
    process.env.NODE_ENV = 'test'; process.env.ADMIN_PHONE = '+79990000887';
    const admin = await db.user.create({ data: { role: 'ADMIN', name: 'Главный администратор', phone: process.env.ADMIN_PHONE } });
    const owner = await db.user.create({ data: { role: 'USER', name: 'Владелец', phone: '+79990000003' } });
    const seller = await db.user.create({ data: { role: 'SELLER', phone: '+79990000004' } });
    const otherAdmin = await db.user.create({ data: { role: 'ADMIN', phone: '+79990000005' } });
    const point = await db.marketPoint.findFirstOrThrow();
    await db.marketPointOwner.create({ data: { userId: owner.id, marketPointId: point.id } });
    await db.product.update({ where: { id: 1 }, data: { marketPointId: point.id } });
    const { DbService } = await load('db/db.service');
    const { AuthService, SID } = await load('auth/auth.service');
    const { ServiceFeeCtrl } = await load('admin/service-fee.ctrl');
    const { ServiceFeeService } = await load('admin/service-fee.service');
    const { AdminProductsCtrl } = await load('admin/products.ctrl');
    const { AdminProductsService } = await load('admin/products.service');
    const { SettingsCtrl, PublicSettingsCtrl } = await load('admin/settings.ctrl');
    const { SettingsService } = await load('admin/settings.service');
    const { OwnerCtrl } = await load('admin/owner.ctrl');
    const { ImagesService } = await load('admin/images.service');
    const { AdminCategoriesCtrl } = await load('admin/categories.ctrl');
    const { AdminCategoriesService } = await load('admin/categories.service');
    const { AdminUsersCtrl } = await load('admin/users.ctrl');
    const { AdminUsersService } = await load('admin/users.service');
    const images = new ImagesService(db);
    const users = { ADMIN: admin.id, OWNER: owner.id, SELLER: seller.id, OTHER_ADMIN: otherAdmin.id };
    const me = async token => users[token] ? db.user.findUnique({ where: { id: users[token] }, include: { ownedPoints: { select: { marketPointId: true } } } }) : null;
    const module = await Test.createTestingModule({ controllers: [AdminUsersCtrl, ServiceFeeCtrl, AdminProductsCtrl, SettingsCtrl, PublicSettingsCtrl, OwnerCtrl, AdminCategoriesCtrl], providers: [
      { provide: AdminUsersService, useValue: new AdminUsersService(db) },
      { provide: ServiceFeeService, useValue: new ServiceFeeService(db) },
      { provide: DbService, useValue: db }, { provide: AdminProductsService, useValue: new AdminProductsService(db, images) },
      { provide: SettingsService, useValue: new SettingsService(db) }, { provide: ImagesService, useValue: images },
      { provide: AdminCategoriesService, useValue: new AdminCategoriesService(db) }, { provide: AuthService, useValue: { me } },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.enableCors({ origin: /^http:\/\/127\.0\.0\.1:\d+$/, credentials: true }); app.use(cookieParser());
    const requests = [];
    app.use(async (request, response, next) => {
      const path = request.path;
      if (path === '/api/auth/me') return response.json(await me(request.cookies[SID]));
      if (path === '/api/admin/market-map/points') return response.json(await db.marketPoint.findMany());
      if (path === '/api/admin/seasons') return response.json([]);
      if (path === '/api/staff/orders/new-summary') return response.json({ count: 0, latestOrderId: null });
      if (path.endsWith('/orders/unread')) return response.json({ count: 0, latestOrderId: null });
      if (path === '/api/in-app/events') return response.json({ scope: null, events: [], hasMore: false });
      if (path === '/api/favorites') return response.json({ items: [] });
      if (path === '/api/cart') return response.json({ revision: '0', items: [], products: [], subtotal: 0, valid: true, error: null });
      if (path === '/api/order-phones') return response.json({ primaryPhone: null, phones: [] });
      if (['POST','PATCH'].includes(request.method)) response.on('finish', () => requests.push({ path, method: request.method, body: request.body, status: response.statusCode }));
      next();
    });
    app.setGlobalPrefix('api'); app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    const history = async () => ({ orders: await db.order.findMany(), items: await db.orderItem.findMany(), payments: await db.orderPayment.findMany() });
    return { adminId: admin.id, apiBase: await app.getUrl() + '/api', db, requests, cookieName: SID, history, historical: await history(),
      categoryId: (await db.category.findUniqueOrThrow({ where: { slug: 'fee-ui' } })).id,
      async lockProduct() {
        const lock = new pg.Client({ connectionString: target.href }); await lock.connect();
        await lock.query(`SET search_path TO "${schema}"`); await lock.query('BEGIN');
        await lock.query('LOCK TABLE "Product" IN ROW EXCLUSIVE MODE');
        return async () => { await lock.query('ROLLBACK'); await lock.end(); };
      }, close };
  } catch (cause) { await close(); throw cause; }
}
