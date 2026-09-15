import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { DbModule } from '../src/db/db.module.js';
import { OrderModule } from '../src/order/order.module.js';
import { PublicSettingsCtrl } from '../src/admin/settings.ctrl.js';
import { SettingsService } from '../src/admin/settings.service.js';
import { SID } from '../src/auth/auth.service.js';

describe.skipIf(!process.env.DATABASE_URL)(
  'Cart quote / checkout HTTP PostgreSQL',
  () => {
    const schema = `cart_test_${randomUUID().replaceAll('-', '')}`;
    const connection = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    let db: PrismaClient;
    let app: NestExpressApplication;
    let created = false;
    let productId: number;
    let categoryId: number;
    let cookie: string;
    let legacyProducts: { id: number; min: number; step: number }[] = [];
    const items = () => [{ productId, qty: 1000 }];
    const quote = () =>
      request(app.getHttpServer())
        .post('/api/orders/quote')
        .send({ items: items(), subtotal: 1 });
    const order = (
      type: 'DELIVERY' | 'PICKUP',
      quoteToken?: string,
      session = '',
    ) =>
      request(app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', session)
        .send({
          type,
          quoteToken,
          items: items(),
          customerName: 'Покупатель',
          customerPhone: '+79990000444',
          ...(type === 'DELIVERY'
            ? { address: { city: 'Москва', street: 'Тестовая', house: '1' } }
            : {}),
        });
    beforeAll(async () => {
      vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
      vi.stubEnv('ORDER_SMS_ENABLED', 'false');
      await connection.connect();
      if (!/^cart_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe schema');
      await connection.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await connection.query(`SET search_path TO "${schema}"`);
      const root = resolve('prisma/migrations');
      for (const migration of (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (migration.name === '20260915120000_product_portion_qty') {
          await connection.query(`
            INSERT INTO "Category" (id, name, slug, "updatedAt")
              VALUES (-1, 'Legacy fixtures', 'legacy-fixtures', NOW());
            INSERT INTO "Product" (id, name, slug, price, unit, "categoryId", min, step, "updatedAt") VALUES
              (-1, 'Legacy grams', 'legacy-grams', 100, 'GRAM', -1, 500, 1, NOW()),
              (-2, 'Legacy grid', 'legacy-grid', 100, 'GRAM', -1, 500, 300, NOW()),
              (-3, 'Legacy zero', 'legacy-zero', 100, 'PIECE', -1, 0, 0, NOW()),
              (-4, 'Legacy negative', 'legacy-negative', 100, 'PIECE', -1, -1, 1, NOW());
          `);
          legacyProducts = (await connection.query<{ id: number; min: number; step: number }>(
            'SELECT * FROM "Product" WHERE id < 0 ORDER BY id',
          )).rows;
        }
        await connection.query(
          await readFile(join(root, migration.name, 'migration.sql'), 'utf8'),
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
      const module = await Test.createTestingModule({
        imports: [OrderModule, DbModule],
        controllers: [PublicSettingsCtrl],
        providers: [SettingsService],
      })
        .overrideProvider(DbService)
        .useValue(db)
        .compile();
      app = module.createNestApplication<NestExpressApplication>({
        logger: false,
      });
      app.use(cookieParser());
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
      await app.init();
      categoryId = (
        await db.category.create({ data: { name: 'Фрукты', slug: 'fruit' } })
      ).id;
      const user = await db.user.create({
        data: { phone: '+79990000444', role: 'USER' },
      });
      const token = randomBytes(32).toString('hex');
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      cookie = `${SID}=${token}`;
    }, 30000);
    beforeEach(async () => {
      productId = (
        await db.product.create({
          data: {
            name: 'Яблоки',
            slug: randomUUID(),
            description: 'Not needed in cart',
            price: 350000,
            priceQty: 1000,
            unit: 'GRAM',
            min: 1000,
            step: 250,
            portionQty: 1000,
            categoryId,
          },
        })
      ).id;
      await db.shopSettings.update({
        where: { id: 1 },
        data: {
          minDeliverySubtotal: 300000,
          deliveryEnabled: true,
          pickupEnabled: true,
        },
      });
    });
    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
      if (created && /^cart_test_[a-f0-9]{32}$/.test(schema))
        await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
      await connection.end();
      vi.unstubAllEnvs();
    }, 30000);

    it('migration backfills every legacy product from min without changing existing columns', async () => {
      expect(legacyProducts).toHaveLength(4);
      const result = await connection.query('SELECT * FROM "Product" WHERE id < 0 ORDER BY id');
      expect(result.rows).toEqual(legacyProducts.map((product) => ({
        ...product, portionQty: product.min,
      })));
      const column = await connection.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'Product' AND column_name = 'portionQty'`,
        [schema],
      );
      expect(column.rows).toEqual([{ is_nullable: 'NO' }]);
      await expect(connection.query('UPDATE "Product" SET "portionQty" = NULL WHERE id = -1'))
        .rejects.toMatchObject({ code: '23502' });
    });
    it('quote is public, read-only and restricted to the public product contract', async () => {
      const before = await db.order.count();
      const guests = await db.guestSession.count();
      await db.productImage.createMany({
        data: [
          { productId, url: '/uploads/products/visible.webp', visible: true },
          { productId, url: '/uploads/products/hidden.webp', visible: false },
        ],
      });
      const result = await quote().expect(201);
      expect(result.body.subtotal).toBe(350000);
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(result.body.items[0].product.images).toEqual([
        { url: '/uploads/products/visible.webp', alt: null },
      ]);
      expect(Object.keys(result.body.items[0].product).sort()).toEqual(
        [
          'id',
          'name',
          'slug',
          'price',
          'priceQty',
          'portionQty',
          'unit',
          'min',
          'step',
          'category',
          'images',
        ].sort(),
      );
      expect(await db.order.count()).toBe(before);
      expect(await db.guestSession.count()).toBe(guests);
      const settings = await request(app.getHttpServer())
        .get('/api/shop/settings')
        .expect(200);
      expect(Object.keys(settings.body).sort()).toEqual(
        ['minDeliverySubtotal', 'deliveryEnabled', 'pickupEnabled'].sort(),
      );
    });
    it('price decrease updates quote, blocks delivery below minimum but permits guest pickup', async () => {
      await quote()
        .expect(201)
        .expect((result) => expect(result.body.subtotal).toBe(350000));
      await db.product.update({
        where: { id: productId },
        data: { price: 250000 },
      });
      const current = await quote().expect(201);
      expect(current.body.subtotal).toBe(250000);
      await order('DELIVERY', current.body.token as string).expect(400);
      const pickup = await order('PICKUP', current.body.token as string).expect(
        201,
      );
      expect(pickup.body).toMatchObject({
        subtotal: 250000,
        deliveryPrice: 0,
        total: 250000,
      });
    });
    it('price increase updates quote and makes delivery eligible for a USER', async () => {
      await db.product.update({
        where: { id: productId },
        data: { price: 250000 },
      });
      expect((await quote()).body.subtotal).toBe(250000);
      await db.product.update({
        where: { id: productId },
        data: { price: 350000 },
      });
      const current = await quote().expect(201);
      const result = await order(
        'DELIVERY',
        current.body.token as string,
        cookie,
      ).expect(201);
      expect(result.body).toMatchObject({
        subtotal: 350000,
        deliveryPrice: null,
        total: null,
      });
      expect(
        (
          await db.order.findUniqueOrThrow({
            where: { publicId: result.body.publicId as string },
          })
        ).userId,
      ).not.toBeNull();
    });
    it.each(['price', 'priceQty', 'min', 'step', 'portionQty', 'active'] as const)(
      'change to %s after quote returns 409 before order creation',
      async (field) => {
        const before = await db.order.count();
        const old = await quote().expect(201);
        await db.product.update({
          where: { id: productId },
          data: {
            [field]:
              field === 'active'
                ? false
                : field === 'price'
                  ? 360000
                  : field === 'portionQty'
                    ? 2000
                  : field === 'min'
                    ? 1500
                    : 500,
          },
        });
        const result = await order('PICKUP', old.body.token as string).expect(
          409,
        );
        expect(result.body.code).toBe('CART_CHANGED');
        expect(await db.order.count()).toBe(before);
      },
    );
    it('legacy create without a fingerprint still reads current prices and checks current settings', async () => {
      await quote();
      await db.product.update({
        where: { id: productId },
        data: { price: 250000 },
      });
      await order('DELIVERY').expect(400);
      await order('PICKUP')
        .expect(201)
        .expect((result) => expect(result.body.subtotal).toBe(250000));
      await db.shopSettings.update({
        where: { id: 1 },
        data: { minDeliverySubtotal: 0 },
      });
      await order('DELIVERY').expect(201);
      await db.shopSettings.update({
        where: { id: 1 },
        data: { deliveryEnabled: false },
      });
      await order('DELIVERY').expect(400);
      await db.shopSettings.update({
        where: { id: 1 },
        data: { pickupEnabled: false, deliveryEnabled: true },
      });
      await order('PICKUP').expect(400);
    });
    it.each([
      { price: 15000, priceQty: 500, expected: [15000, 30000, 45000] },
      { price: 19900, priceQty: 1000, expected: [9950, 19900, 29850] },
    ])('quote and persisted order agree for price=$price / priceQty=$priceQty', async ({ price, priceQty, expected }) => {
      await db.product.update({ where: { id: productId }, data: { min: 500, step: 100, portionQty: 500, price, priceQty } });
      for (const [index, qty] of [500, 1000, 1500].entries()) {
        const items = [{ productId, qty, price: 1, total: 1, step: 1, portionQty: 1 }];
        const quoted = await request(app.getHttpServer()).post('/api/orders/quote').send({ items }).expect(201);
        expect(quoted.body.subtotal).toBe(expected[index]);
        expect(quoted.body.items[0].product.portionQty).toBe(500);
        const created = await request(app.getHttpServer()).post('/api/orders').set('Cookie', cookie).send({
          type: 'PICKUP', customerName: 'Покупатель', customerPhone: '+79990000444',
          items, quoteToken: quoted.body.token, subtotal: 1,
        }).expect(201);
        const saved = await db.order.findUniqueOrThrow({ where: { publicId: created.body.publicId as string }, include: { items: true } });
        expect(saved).toMatchObject({ subtotal: expected[index], total: expected[index] });
        expect(saved.items[0]).toMatchObject({ qty, price, priceQty, unit: 'GRAM', total: expected[index] });
        await db.product.update({ where: { id: productId }, data: { price: price + 100 } });
        expect((await db.orderItem.findUniqueOrThrow({ where: { id: saved.items[0]!.id } })).total).toBe(expected[index]);
        await db.product.update({ where: { id: productId }, data: { price } });
      }
    });
    it('accepts manual desired total independently of the catalogue portion and rejects 501g', async () => {
      await db.product.update({ where: { id: productId }, data: { min: 500, step: 100, portionQty: 1000, price: 19900, priceQty: 1000 } });
      const before = await db.order.count();
      const invalid = [{ productId, qty: 501, min: 1, step: 1, portionQty: 1 }];
      const quoted = await request(app.getHttpServer()).post('/api/orders/quote').send({ items: invalid }).expect(201);
      expect(quoted.body).toMatchObject({ valid: false, items: [{ qty: 501, status: 'INVALID_QUANTITY' }] });
      const checkout = (qty: number) => request(app.getHttpServer()).post('/api/orders').set('Cookie', cookie).send({
        type: 'PICKUP', customerName: 'Покупатель', customerPhone: '+79990000444', items: [{ productId, qty }],
      });
      await checkout(501).expect(400);
      expect(await db.order.count()).toBe(before);
      const created = await checkout(700).expect(201);
      const saved = await db.order.findUniqueOrThrow({ where: { publicId: created.body.publicId as string }, include: { items: true } });
      expect(saved.items[0]).toMatchObject({ qty: 700, total: 13930 });
    });
    it.each(['hidden', 'deleted'])(
      '%s product is a structured unavailable line without disclosing its data',
      async (state) => {
        if (state === 'hidden')
          await db.product.update({
            where: { id: productId },
            data: { active: false },
          });
        else await db.product.delete({ where: { id: productId } });
        const result = await quote().expect(201);
        expect(result.body).toMatchObject({
          valid: false,
          subtotal: null,
          token: null,
          items: [{ productId, product: null, status: 'UNAVAILABLE' }],
        });
      },
    );
    it('min=500 step=300 accepts 500/800/1100, rejects legacy 1000 without changing it', async () => {
      await db.product.update({
        where: { id: productId },
        data: { min: 500, step: 300 },
      });
      for (const qty of [500, 800, 1100, 1000]) {
        const result = await request(app.getHttpServer())
          .post('/api/orders/quote')
          .send({ items: [{ productId, qty }] })
          .expect(201);
        expect(result.body.items[0].qty).toBe(qty);
        expect(result.body.items[0].status).toBe(
          qty === 1000 ? 'INVALID_QUANTITY' : 'AVAILABLE',
        );
      }
    });
  },
);
