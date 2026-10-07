import 'dotenv/config';
import { randomUUID } from 'node:crypto';
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
import type { DbService } from '../src/db/db.service.js';
import { ProductCtrl } from '../src/product/product.ctrl.js';
import { ProductService } from '../src/product/product.service.js';
import { CategoryCtrl } from '../src/category/category.ctrl.js';
import { CategoryService } from '../src/category/category.service.js';
import { FavoriteCtrl } from '../src/favorite/favorite.ctrl.js';
import { FavoriteService } from '../src/favorite/favorite.service.js';
import { CartCtrl } from '../src/cart/cart.ctrl.js';
import { CartService } from '../src/cart/cart.service.js';
import { OrderCtrl } from '../src/order/order.ctrl.js';
import { OrderService } from '../src/order/order.service.js';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { StaffService } from '../src/staff/staff.service.js';
import type { NotificationService } from '../src/order/notification.service.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import * as pricing from '../src/product/pricing.js';
import { categories, marketProducts, sourceCheckedAt } from '../data/market-products/2026-10-06.js';
import { importMarketProducts } from '../data/market-products/import.js';
import { estimatedDataset } from '../data/market-products/2026-10-07-estimated.js';

describe.skipIf(!process.env.DATABASE_URL)('market pricing/import / temporary PostgreSQL', () => {
  const schema = `market_products_test_${randomUUID().replaceAll('-', '')}`;
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>;
  let created = false, userId: number, adminId: number;
  let oldProducts: Record<string, unknown>[], oldItems: Record<string, unknown>[];
  const http = () => request(app.getHttpServer());
  const cookie = (role: 'USER' | 'ADMIN') => `${SID}=${role}`;
  const slugs = marketProducts.map(row => row.slug);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local test database required');
    vi.stubEnv('ADMIN_PHONE', '+79990000887');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^market_products_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20261006140000_market_products') {
        await connection.query(`INSERT INTO "Category" ("name", "slug", "sort", "updatedAt") VALUES
          ('Овощи', 'vegetables', 1, '2026-10-05'), ('Фрукты', 'fruits', 2, '2026-10-05'), ('Зелень', 'greens', 3, '2026-10-05');
          INSERT INTO "Product" ("id", "name", "slug", "price", "unit", "priceQty", "min", "step", "portionQty", "categoryId", "active", "updatedAt")
          VALUES (-1, 'Demo', 'demo-market-product', 10000, 'PIECE', 1, 1, 1, 1, 1, true, '2026-10-05'),
            (-2, 'Hidden demo', 'hidden-demo', 22000, 'PIECE', 1, 1, 1, 1, 2, false, '2026-10-05');
          INSERT INTO "Order" ("id", "type", "customerName", "customerPhone", "subtotal", "total", "updatedAt")
          VALUES (-1, 'PICKUP', 'Legacy', '+79990000100', 10000, 10000, '2026-10-05');
          INSERT INTO "OrderItem" ("id", "productName", "productSlug", "price", "priceQty", "unit", "qty", "total", "orderId", "productId")
          VALUES (-1, 'Demo', 'demo-market-product', 10000, 1, 'PIECE', 1, 10000, -1, -1);`);
        oldProducts = (await connection.query<Record<string, unknown>>('SELECT * FROM "Product" ORDER BY id')).rows;
        oldItems = (await connection.query<Record<string, unknown>>('SELECT * FROM "OrderItem" ORDER BY id')).rows;
      }
      await connection.query(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    }
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    userId = (await db.user.create({ data: { role: 'USER' } })).id;
    adminId = (await db.user.create({ data: { role: 'ADMIN', phone: '+79990000887' } })).id;
    await db.shopSettings.upsert({ where: { id: 1 }, create: { id: 1, minDeliverySubtotal: 0 }, update: { minDeliverySubtotal: 0 } });
    await db.shopHours.updateMany({ data: { enabled: true, openMinutes: 0, closeMinutes: 1440 } });
    const database = db as unknown as DbService;
    const orders = new OrderService(database, { notifyNewOrder: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService);
    const images = new ImagesService(database);
    const module = await Test.createTestingModule({
      controllers: [ProductCtrl, CategoryCtrl, FavoriteCtrl, CartCtrl, OrderCtrl, AdminProductsCtrl],
      providers: [
        { provide: ProductService, useValue: new ProductService(database) },
        { provide: CategoryService, useValue: new CategoryService(database) },
        { provide: FavoriteService, useValue: new FavoriteService(database) },
        { provide: OrderService, useValue: orders },
        { provide: CartService, useValue: new CartService(database, orders) },
        { provide: ImagesService, useValue: images },
        { provide: AdminProductsService, useValue: new AdminProductsService(database, images) },
        { provide: AuthService, useValue: { me: async (token?: string) => token === 'USER' ? { id: userId, role: 'USER' } :
          token === 'ADMIN' ? { id: adminId, role: 'ADMIN', phone: '+79990000887' } : null } },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true })); await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^market_products_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end(); vi.unstubAllEnvs();
  });

  it('migrates nullable product fields without changing seller prices or historical orders', async () => {
    expect((await connection.query('SELECT * FROM "Product" ORDER BY id')).rows).toEqual(oldProducts.map(row => ({
      ...row, marketPointId: null, sourceUrl: null, sourceCheckedAt: null, priceStatus: 'ESTIMATED',
    })));
    expect((await connection.query('SELECT * FROM "OrderItem" ORDER BY id')).rows).toEqual(oldItems.map(row => ({
      ...row, serviceMarkupPercentSnapshot: null,
    })));
    expect((await db.order.findUniqueOrThrow({ where: { id: -1 } })).total).toBe(10000);
    const indexes = await connection.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2', [schema, 'Product_marketPointId_idx']);
    expect(indexes.rows).toHaveLength(1);
    await expect(db.product.update({ where: { id: -1 }, data: { marketPointId: 2147483647 } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('dry-run plans all 40 products and 7 categories without writing anything', async () => {
    const result = await importMarketProducts(db);
    expect(result).toMatchObject({ ok: true, dryRun: true, created: 40, updated: 0,
      counts: { 'cezoni-market': 34, 'grand-bazar': 6 } });
    expect(result.products[0]).toMatchObject({ sellerPrice: 22000, customerPrice: 24200 });
    expect(await db.product.count()).toBe(2);
    expect(await db.category.count()).toBe(3);
  });

  it('reports a missing MarketPoint and refuses apply without creating categories or points', async () => {
    const point = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'cezoni-market' } });
    await db.marketPoint.delete({ where: { id: point.id } });
    try {
      expect(await importMarketProducts(db)).toMatchObject({ ok: false, products: [], errors: [expect.stringContaining('cezoni-market')] });
      await expect(importMarketProducts(db, false)).rejects.toThrow('Не найдены MarketPoint');
      expect(await db.category.count()).toBe(3);
      expect(await db.product.count()).toBe(2);
      expect(await db.marketPoint.count()).toBe(59);
    } finally { await db.marketPoint.create({ data: point }); }
  });

  it('refuses a foreign slug collision and leaves the existing product untouched', async () => {
    const foreign = await db.product.create({ data: { slug: slugs[0]!, name: 'Foreign', price: 12345,
      priceQty: 1, unit: 'PIECE', min: 1, step: 1, portionQty: 1, categoryId: 1, active: false } });
    try {
      expect(await importMarketProducts(db)).toMatchObject({ ok: false, errors: [expect.stringContaining('Slug занят')] });
      await expect(importMarketProducts(db, false)).rejects.toThrow('Slug занят');
      expect(await db.product.findUnique({ where: { id: foreign.id } })).toEqual(foreign);
      expect(await db.category.count()).toBe(3);
    } finally { await db.product.delete({ where: { id: foreign.id } }); }
  });

  it('applies seller prices and source metadata, connects existing market points and imports no images', async () => {
    const result = await importMarketProducts(db, false);
    expect(result).toMatchObject({ ok: true, dryRun: false, created: 40, updated: 0 });
    const rows = await db.product.findMany({ where: { slug: { in: slugs } }, include: { marketPoint: true, images: true } });
    expect(rows).toHaveLength(40);
    for (const source of marketProducts) {
      const row = rows.find(product => product.slug === source.slug)!;
      expect(row).toMatchObject({ price: source.sellerPrice, unit: 'PIECE', priceQty: 1, step: 1, min: 1, portionQty: 1,
        sourceUrl: source.sourceUrl, sourceCheckedAt: new Date(sourceCheckedAt), marketPoint: { slug: source.marketPointSlug }, images: [] });
    }
    expect(await db.marketPoint.count()).toBe(60);
    expect(await db.product.count({ where: { marketPoint: { slug: 'goldfish' } } })).toBe(0);
    expect(await db.product.count({ where: { price: 0 } })).toBe(0);
    expect(await db.category.count()).toBe(10);
  });

  it('repeat apply is idempotent, never compounds markup or changes unrelated products', async () => {
    const before = await db.product.findMany({ orderBy: { id: 'asc' } });
    const result = await importMarketProducts(db, false);
    expect(result).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 40 });
    expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect((await db.product.findUniqueOrThrow({ where: { slug: slugs[0]! } })).price).toBe(22000);
    expect((await http().get(`/api/products/${slugs[0]}`).expect(200)).body.price).toBe(24200);
  });

  it('updates only owned source fields while preserving photos, publication and settlement settings', async () => {
    const row = await db.product.findUniqueOrThrow({ where: { slug: slugs[0]! } });
    await db.product.update({ where: { id: row.id }, data: { price: 10000, active: false, sort: 999,
      settlementMode: 'SHARED_MARKUP', basePrice: 18000, description: 'Own description' } });
    const image = await db.productImage.create({ data: { productId: row.id, url: '/uploads/products/own.webp' } });
    const category = await db.category.findUniqueOrThrow({ where: { slug: 'grocery' } });
    await db.category.update({ where: { id: category.id }, data: { name: 'Бакалея своя', sort: 999 } });
    expect(await importMarketProducts(db, false)).toMatchObject({ updated: 1, unchanged: 39 });
    expect(await db.product.findUniqueOrThrow({ where: { id: row.id }, include: { images: true } }))
      .toMatchObject({ price: 22000, active: false, sort: 999, description: 'Own description',
        settlementMode: 'SHARED_MARKUP', basePrice: 18000, images: [image] });
    expect(await db.category.findUniqueOrThrow({ where: { id: category.id } })).toMatchObject({ name: 'Бакалея своя', sort: 999 });
    await db.product.update({ where: { id: row.id }, data: { active: true } });
  });

  it('public product/search/category APIs expose customer prices and minimal market info without source data', async () => {
    const list = await http().get('/api/products?limit=60').expect(200);
    expect(list.body.total).toBe(41);
    for (const row of marketProducts) {
      const product = list.body.items.find((item: { slug: string }) => item.slug === row.slug);
      expect(product.price).toBe(pricing.customerPrice(row.sellerPrice));
      expect(Object.keys(product.marketPoint).sort()).toEqual(['name', 'slug']);
      for (const field of ['sellerPrice', 'sourceUrl', 'sourceCheckedAt', 'marketPointId', 'basePrice', 'settlementMode'])
        expect(product).not.toHaveProperty(field);
    }
    const detail = await http().get(`/api/products/${slugs[0]}`).expect(200);
    expect(detail.body).toMatchObject({ price: 24200, marketPoint: { slug: 'cezoni-market', name: 'Cezoni Market' } });
    const searched = await http().get('/api/products?q=Карнароли&category=pasta-grains').expect(200);
    expect(searched.body.items[0].price).toBe(24200);
    const filtered = await http().get('/api/products?marketPoint=grand-bazar&limit=60').expect(200);
    expect(filtered.body.items).toHaveLength(6);
    const categoryList = (await http().get('/api/categories').expect(200)).body as { slug: string }[];
    expect(categoryList.map(row => row.slug)).toEqual(expect.arrayContaining(['vegetables', 'fruits', 'greens', ...categories.map(row => row.slug)]));
  });

  it('favorites return customer prices and hidden points do not produce broken public links', async () => {
    const row = await db.product.findUniqueOrThrow({ where: { slug: slugs[0]! } });
    await http().post(`/api/favorites/${row.id}`).set('Cookie', cookie('USER')).expect(201);
    expect((await http().get('/api/favorites').set('Cookie', cookie('USER')).expect(200)).body.items[0].price).toBe(24200);
    await db.marketPoint.update({ where: { id: row.marketPointId! }, data: { isPublished: false } });
    try {
      expect((await http().get(`/api/products/${row.slug}`).expect(200)).body).toMatchObject({ price: 24200, marketPoint: null });
      expect((await http().get('/api/products?marketPoint=cezoni-market').expect(200)).body.items).toEqual([]);
    } finally { await db.marketPoint.update({ where: { id: row.marketPointId! }, data: { isPublished: true } }); }
  });

  it('admin edits seller prices and source metadata; repeated saves never become 110 → 121', async () => {
    const row = await db.product.create({ data: { name: 'Pricing regression', slug: 'pricing-regression', price: 10000,
      unit: 'PIECE', priceQty: 1, min: 1, step: 1, portionQty: 1, categoryId: 1 } });
    for (let i = 0; i < 3; i++) {
      const product = (await http().get(`/api/admin/products/${row.id}`).set('Cookie', cookie('ADMIN')).expect(200)).body;
      expect(product).toMatchObject({ price: 10000, sellerPrice: 10000, serviceMarkup: 1000, serviceMarkupPercent: 10, customerPrice: 11000 });
      await http().patch(`/api/admin/products/${row.id}`).set('Cookie', cookie('ADMIN'))
        .send({ price: product.price, sourceUrl: 'https://cezoni.com/collection/all', sourceCheckedAt }).expect(200);
    }
    const preview = await http().post('/api/admin/products/pricing').set('Cookie', cookie('ADMIN')).send({ price: 49500 }).expect(201);
    expect(preview.body.customerPrice).toBe(54450);
    await http().patch(`/api/admin/products/${row.id}`).set('Cookie', cookie('ADMIN')).send({ customerPrice: 12100 }).expect(400);
    await http().post('/api/admin/products/pricing').set('Cookie', cookie('USER')).send({ price: 49500 }).expect(403);
    expect((await db.product.findUniqueOrThrow({ where: { id: row.id } })).price).toBe(10000);
  });

  it('cart, checkout and OrderItem use customer prices, and snapshots survive later source/percentage changes', async () => {
    const product = await db.product.findUniqueOrThrow({ where: { slug: 'pricing-regression' } });
    const empty = (await http().get('/api/cart').set('Cookie', cookie('USER')).expect(200)).body;
    const basket = (await http().post('/api/cart/change').set('Cookie', cookie('USER'))
      .send({ revision: empty.revision, kind: 'add', productId: product.id, qty: 2 }).expect(201)).body;
    expect(basket).toMatchObject({ subtotal: 22000, products: [{ price: 11000 }], items: [{ product: { price: 11000 }, lineTotal: 22000 }] });
    const createdOrder = (await http().post('/api/cart/checkout').set('Cookie', cookie('USER')).send({
      revision: basket.revision, type: 'PICKUP', customerName: 'Pricing', customerPhone: '+79990000999',
      quoteToken: basket.token, total: 1, price: 1,
    }).expect(201)).body.order;
    const saved = await db.order.findUniqueOrThrow({ where: { id: createdOrder.id }, include: { items: true } });
    expect(saved).toMatchObject({ subtotal: 22000, total: 22000, items: [{ price: 11000, total: 22000 }] });
    await db.product.update({ where: { id: product.id }, data: { price: 20000 } });
    const original = pricing.customerPrice;
    const changedRate = vi.spyOn(pricing, 'customerPrice').mockImplementation(seller => original(seller, 15));
    try {
      expect((await http().get(`/api/products/${product.slug}`).expect(200)).body.price).toBe(23000);
      expect(await db.order.findUniqueOrThrow({ where: { id: saved.id }, include: { items: true } })).toEqual(saved);
      expect((await http().get(`/api/orders/${saved.publicId}`).set('Cookie', cookie('USER')).expect(200)).body)
        .toMatchObject({ subtotal: 22000, total: 22000, items: [{ price: 11000, total: 22000 }] });
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: -1 } })).price).toBe(10000);
    } finally { changedRate.mockRestore(); }
    const item = saved.items[0]!;
    await db.order.update({ where: { id: saved.id }, data: { status: 'ASSEMBLING' } });
    await db.orderItem.update({ where: { id: item.id }, data: { status: 'PICKED', actualQty: 2, actualTotal: 22000 } });
    const notifications = { dispatch: vi.fn().mockResolvedValue(undefined), dispatchTelegram: vi.fn().mockResolvedValue(undefined),
      dispatchStaffPrice: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationService;
    const staff = new StaffService(db as unknown as DbService, notifications);
    const requestId = randomUUID();
    const actor = { userId: adminId, role: 'ADMIN' as const };
    await staff.itemPrice(saved.id, item.id, { sellerPrice: 12000, reason: 'Confirmed seller price', requestId }, actor);
    await staff.itemPrice(saved.id, item.id, { sellerPrice: 12000, reason: 'Confirmed seller price', requestId }, actor);
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ price: 11000, total: 22000, actualPrice: 13200, actualTotal: 26400 });
    expect(await db.orderItemPriceChange.count({ where: { itemId: item.id } })).toBe(1);
    expect(await staff.finishAssembly(saved.id, actor)).toMatchObject({ subtotal: 22000, total: 22000, finalSubtotal: 26400, finalTotal: 26400 });
  });

  it('220 → 242 snapshot stays immutable; seller correction 250 → 275 is applied once and then frozen', async () => {
    const product = await db.product.create({ data: { name: 'Seller correction', slug: 'seller-correction', price: 22000,
      unit: 'PIECE', priceQty: 1, min: 1, step: 1, portionQty: 1, categoryId: 1 } });
    expect((await http().get(`/api/products/${product.slug}`).expect(200)).body.price).toBe(24200);
    const notifications = { dispatch: vi.fn().mockResolvedValue(undefined), dispatchTelegram: vi.fn().mockResolvedValue(undefined),
      dispatchStaffPrice: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationService;
    const orders = new OrderService(db as unknown as DbService, { notifyNewOrder: vi.fn() } as unknown as TelegramService);
    const { order } = await db.$transaction(tx => orders.createIn(tx, userId, {
      type: 'PICKUP', customerName: 'Audit', customerPhone: '+79990000999', items: [{ productId: product.id, qty: 1 }],
    }));
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(item).toMatchObject({ price: 24200, total: 24200, serviceMarkupPercentSnapshot: 10 });
    await db.order.update({ where: { id: order.id }, data: { status: 'ASSEMBLING' } });
    const staff = new StaffService(db as unknown as DbService, notifications);
    const actor = { userId: adminId, role: 'ADMIN' as const };
    const request = { sellerPrice: 25000, requestId: randomUUID() };
    const saved = await staff.itemPrice(order.id, item.id, request, actor);
    expect(saved).toMatchObject({ price: 24200, actualPrice: 27500, actualSellerPrice: 25000 });
    await staff.itemPrice(order.id, item.id, request, actor);
    await staff.itemPrice(order.id, item.id, { ...request, requestId: randomUUID() }, actor);
    expect(await db.orderItemPriceChange.count({ where: { itemId: item.id } })).toBe(1);
    expect(await db.orderItemPriceChange.findFirstOrThrow({ where: { itemId: item.id } }))
      .toMatchObject({ sellerPrice: 25000, previousPrice: 24200, newPrice: 27500 });
    expect((await staff.get(order.id)).items[0]).toMatchObject({ actualSellerPrice: 25000 });
    await db.product.update({ where: { id: product.id }, data: { price: 30000 } });
    const original = pricing.customerPrice;
    const changedRate = vi.spyOn(pricing, 'customerPrice').mockImplementation((seller, percent) => original(seller, percent ?? 15));
    try {
      expect((await http().get(`/api/products/${product.slug}`).expect(200)).body.price).toBe(34500);
      await staff.itemPrice(order.id, item.id, request, actor);
      await staff.itemPrice(order.id, item.id, { ...request, requestId: randomUUID() }, actor);
      const current = await db.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(current).toMatchObject({ price: 24200, total: 24200, actualPrice: 27500, serviceMarkupPercentSnapshot: 10 });
      await staff.item(order.id, item.id, { status: 'PICKED', actualQty: 1 }, adminId, actor);
      expect(await staff.finishAssembly(order.id, actor)).toMatchObject({ subtotal: 24200, finalSubtotal: 27500, finalTotal: 27500 });
      const snapshot = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
      expect(snapshot.items[0]).toMatchObject({ price: 24200, actualPrice: 27500, actualTotal: 27500 });
      expect(snapshot.finalSubtotal).not.toBe(25000);
      expect(snapshot.finalSubtotal).not.toBe(30250);
      expect(await db.orderItemPriceChange.count({ where: { itemId: item.id } })).toBe(1);
    } finally { changedRate.mockRestore(); }
  });
  it('extends the catalog idempotently, reuses points/categories, exposes status and protects audited seller prices', async () => {
    const existingPoints = await db.marketPoint.findMany({ where: { slug: { in: ['halal-meat', 'tea-coffee', 'goldfish', 'vkusnaya-stall'] } } });
    const bakery = await db.marketPoint.create({ data: { name: 'Булочная', slug: 'existing-bakery-counter',
      kind: 'STORE', floor: 2, mapX: 25, mapY: 25, isPublished: true } });
    const pickle = await db.category.findUniqueOrThrow({ where: { slug: 'preserves-pickles' } });
    const before = await db.product.count();
    const dry = await importMarketProducts(db, true, estimatedDataset);
    expect(dry).toMatchObject({ ok: true, created: 146, updated: 0, unchanged: 0, pointsCreated: 12 });
    expect(await db.product.count()).toBe(before);
    expect(await db.marketPoint.findUnique({ where: { slug: 'bakery' } })).toBeNull();
    expect(await importMarketProducts(db, false, estimatedDataset)).toMatchObject({ created: 146, updated: 0, unchanged: 0 });
    expect(await importMarketProducts(db, true, estimatedDataset)).toMatchObject({ created: 0, updated: 0, unchanged: 146, pointsCreated: 0 });
    const imported = await db.product.findMany({ where: { slug: { in: estimatedDataset.marketProducts.map(row => row.slug) } },
      include: { marketPoint: true } });
    for (const row of estimatedDataset.marketProducts) {
      const product = imported.find(product => product.slug === row.slug)!;
      expect(product).toMatchObject({ price: row.sellerPrice, priceStatus: row.priceStatus });
      expect(product.marketPoint?.slug).toBe(row.marketPointSlug === 'bakery' ? bakery.slug : row.marketPointSlug);
    }
    expect(await db.marketPoint.findMany({ where: { id: { in: existingPoints.map(point => point.id) } }, orderBy: { id: 'asc' } }))
      .toEqual(existingPoints.sort((a, b) => a.id - b.id));
    expect((await db.product.findFirstOrThrow({ where: { slug: 'bakery-wheat-loaf' } })).marketPointId).toBe(bakery.id);
    expect((await db.product.findFirstOrThrow({ where: { slug: 'domashnie-solenya-salted-cucumbers' } })).categoryId).toBe(pickle.id);
    expect(await db.category.findUnique({ where: { slug: 'pickles' } })).toBeNull();
    expect(await db.productImage.count({ where: { product: { slug: { in: estimatedDataset.marketProducts.map(row => row.slug) } } } })).toBe(0);
    const point = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'romanovskoe-osetrovoe-hozyaystvo' } });
    expect(point).toMatchObject({ mapX: null, mapY: null, isPublished: true });
    const customer = await http().get('/api/products/romanovskoe-osetrovoe-hozyaystvo-chilled-sturgeon').expect(200);
    expect(customer.body).toMatchObject({ price: 209000, priceStatus: 'ESTIMATED', marketPoint: { slug: point.slug } });
    expect(customer.body).not.toHaveProperty('sellerPrice');
    expect(customer.body).not.toHaveProperty('sourceUrl');
    const filtered = await http().get('/api/admin/products').query({ priceStatus: 'ESTIMATED', marketPoint: point.id }).set('Cookie', cookie('ADMIN')).expect(200);
    expect(filtered.body.total).toBe(3);
    const fish = await db.product.findUniqueOrThrow({ where: { slug: 'romanovskoe-osetrovoe-hozyaystvo-chilled-sturgeon' } });
    await http().patch(`/api/admin/products/${fish.id}`).set('Cookie', cookie('ADMIN')).send({ price: 30000, priceStatus: 'AUDITED' }).expect(200);
    expect((await http().get(`/api/products/${fish.slug}`).expect(200)).body).toMatchObject({ price: 33000, priceStatus: 'AUDITED' });
    expect(await importMarketProducts(db, false, estimatedDataset)).toMatchObject({ created: 0, updated: 0, unchanged: 146 });
    expect(await db.product.findUniqueOrThrow({ where: { id: fish.id } })).toMatchObject({ price: 30000, priceStatus: 'AUDITED' });
  });
});
