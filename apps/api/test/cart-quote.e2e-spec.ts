import 'dotenv/config';
import { customerPrice } from '../src/product/pricing.js';
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
import { OrderService } from '../src/order/order.service.js';
import { CartModule } from '../src/cart/cart.module.js';
import { CartService } from '../src/cart/cart.service.js';
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
    let userId: number;
    let cart: CartService;
    let orders: OrderService;
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
      const seededHours = await connection.query<{ weekday: number; openMinutes: number; closeMinutes: number }>(
        'SELECT weekday, "openMinutes", "closeMinutes" FROM "ShopHours" ORDER BY weekday',
      );
      expect(seededHours.rows).toHaveLength(7);
      expect(seededHours.rows.every(row => row.openMinutes === 540 && row.closeMinutes === 1260)).toBe(true);
      // Checkout integration fixtures must remain valid regardless of test wall-clock time.
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
      const module = await Test.createTestingModule({
        imports: [OrderModule, CartModule, DbModule],
        controllers: [PublicSettingsCtrl],
        providers: [SettingsService],
      })
        .overrideProvider(DbService)
        .useValue(db)
        .compile();
      cart = module.get(CartService);
      orders = module.get(OrderService);
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
    }, 30000);
    beforeEach(async () => {
      const user = await db.user.create({
        data: { phone: null, role: 'USER' },
      });
      userId = user.id;
      const token = randomBytes(32).toString('hex');
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      cookie = `${SID}=${token}`;
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

    it('website and bot share revisions, quantity, remove and clear without lost updates', async () => {
      await request(app.getHttpServer()).get('/api/cart').expect(401);
      const first = await cart.get(userId);
      const fromBot = await cart.change(userId, first.revision, { kind: 'add', productId, qty: 1000 });
      const seenByWeb = await request(app.getHttpServer()).get('/api/cart')
        .set('Cookie', cookie).expect(200);
      expect(seenByWeb.body).toMatchObject({
        revision: fromBot.revision,
        items: [{ productId, qty: 1000, status: 'AVAILABLE' }],
        subtotal: 385000,
      });
      const fromWeb = await request(app.getHttpServer()).post('/api/cart/change')
        .set('Cookie', cookie)
        .send({ revision: fromBot.revision, kind: 'set', productId, qty: 1250 }).expect(201);
      expect((await cart.get(userId)).items[0]).toMatchObject({ productId, qty: 1250 });
      await request(app.getHttpServer()).post('/api/cart/change').set('Cookie', cookie)
        .send({ revision: fromBot.revision, kind: 'clear' }).expect(409);
      expect((await cart.get(userId)).items[0]!.qty).toBe(1250);
      const removed = await request(app.getHttpServer()).post('/api/cart/change')
        .set('Cookie', cookie)
        .send({ revision: fromWeb.body.revision, kind: 'remove', productId }).expect(201);
      expect((await cart.get(userId)).items).toHaveLength(0);
      const again = await cart.change(userId, removed.body.revision as string,
        { kind: 'add', productId, qty: 1000 });
      expect((await request(app.getHttpServer()).get('/api/cart')
        .set('Cookie', cookie).expect(200)).body.revision).toBe(again.revision);
      await cart.change(userId, again.revision, { kind: 'clear' });
      expect((await request(app.getHttpServer()).get('/api/cart')
        .set('Cookie', cookie).expect(200)).body.items).toHaveLength(0);
    });

    it('concurrent website and bot writes accept one revision and reject the other', async () => {
      const initial = await cart.get(userId);
      const added = await cart.change(userId, initial.revision,
        { kind: 'add', productId, qty: 1000 });
      const [bot, web] = await Promise.allSettled([
        cart.change(userId, added.revision, { kind: 'plus', productId }),
        request(app.getHttpServer()).post('/api/cart/change').set('Cookie', cookie)
          .send({ revision: added.revision, kind: 'set', productId, qty: 1500 }),
      ]);
      expect(web.status).toBe('fulfilled');
      if (web.status !== 'fulfilled') return;
      expect([201, 409]).toContain(web.value.status);
      expect(bot.status === 'fulfilled' ? web.value.status : 201).toBe(
        bot.status === 'fulfilled' ? 409 : web.value.status,
      );
      const final = await cart.get(userId);
      expect([1250, 1500]).toContain(final.items[0]!.qty);
      expect(final.revision).not.toBe(added.revision);
    });

    it('guest merge imports only missing products and keeps server quantity on duplicates', async () => {
      const second = await db.product.create({ data: {
        name: 'Груши', slug: randomUUID(), price: 120000, priceQty: 1000,
        unit: 'GRAM', min: 500, step: 100, portionQty: 500, categoryId,
      } });
      const first = await cart.get(userId);
      const server = await cart.change(userId, first.revision,
        { kind: 'add', productId, qty: 1000 });
      const merged = await request(app.getHttpServer()).post('/api/cart/merge')
        .set('Cookie', cookie).send({
          revision: server.revision,
          items: [{ productId, qty: 1500 }, { productId: second.id, qty: 500 }],
        }).expect(201);
      expect(merged.body.items).toMatchObject([
        { productId, qty: 1000 },
        { productId: second.id, qty: 500 },
      ]);
      expect((await cart.get(userId)).items).toHaveLength(2);
      await request(app.getHttpServer()).post('/api/cart/merge').set('Cookie', cookie)
        .send({ revision: server.revision, items: [{ productId: second.id, qty: 500 }] })
        .expect(409);
      const repeated = await request(app.getHttpServer()).post('/api/cart/merge')
        .set('Cookie', cookie).send({
          revision: merged.body.revision,
          items: [{ productId, qty: 1500 }, { productId: second.id, qty: 500 }],
        }).expect(201);
      expect(repeated.body.revision).toBe(merged.body.revision);
      expect(repeated.body.items[0].qty).toBe(1000);
      await request(app.getHttpServer()).post('/api/cart/merge').set('Cookie', cookie)
        .send({ revision: repeated.body.revision, items: [
          { productId: second.id, qty: 500 }, { productId: second.id, qty: 500 },
        ] }).expect(400);
      expect((await cart.get(userId)).items).toHaveLength(2);
    });

    it('authenticated website checkout owns another recipient order and empties the bot cart', async () => {
      const first = await cart.get(userId);
      const basket = await cart.change(userId, first.revision,
        { kind: 'add', productId, qty: 1000 });
      const usersBefore = await db.user.count();
      const accountBefore = await db.user.findUniqueOrThrow({ where: { id: userId } });
      const created = await request(app.getHttpServer()).post('/api/cart/checkout')
        .set('Cookie', cookie).send({
          revision: basket.revision, quoteToken: basket.token,
          type: 'DELIVERY', customerName: 'Другой получатель',
          customerPhone: '+79990000445',
          address: { city: 'Москва', street: 'Другая', house: '7', flat: '3' },
        }).expect(201);
      expect(created.body.cart.items).toHaveLength(0);
      const saved = await db.order.findUniqueOrThrow({
        where: { publicId: created.body.order.publicId as string },
      });
      expect(saved).toMatchObject({
        userId, customerName: 'Другой получатель',
        customerPhone: '+79990000445', city: 'Москва', street: 'Другая',
        house: '7', flat: '3',
      });
      expect(await db.user.count()).toBe(usersBefore);
      const accountAfter = await db.user.findUniqueOrThrow({ where: { id: userId } });
      expect(accountAfter.phone).toBe(accountBefore.phone);
      expect(accountAfter.name).toBe(accountBefore.name);
      expect((await cart.get(userId)).items).toHaveLength(0);
      expect((await request(app.getHttpServer()).get('/api/cart')
        .set('Cookie', cookie).expect(200)).body.items).toHaveLength(0);
      const websiteOrders = await request(app.getHttpServer())
        .get('/api/orders').set('Cookie', cookie).expect(200);
      expect(websiteOrders.body.some((order: { publicId: string }) =>
        order.publicId === saved.publicId)).toBe(true);
      expect((await orders.list(userId)).some((order) =>
        order.publicId === saved.publicId)).toBe(true);
      await request(app.getHttpServer()).post('/api/cart/checkout')
        .set('Cookie', cookie).send({
          revision: basket.revision, type: 'PICKUP',
          customerName: 'Retry', customerPhone: '+79990000445',
        }).expect(409);
      expect(await db.order.count({ where: { publicId: saved.publicId } })).toBe(1);
      await order('PICKUP', undefined, cookie).expect(409);
    });

    it('bot checkoutIn clears the cart seen by the next website GET', async () => {
      const first = await cart.get(userId);
      const basket = await cart.change(userId, first.revision,
        { kind: 'add', productId, qty: 1000 });
      const order = await db.$transaction((tx) => cart.checkoutIn(tx, userId,
        basket.revision, {
          type: 'PICKUP', customerName: 'Bot order',
          customerPhone: '+79990000446', quoteToken: basket.token ?? undefined,
        }));
      orders.created(order.id);
      expect((await request(app.getHttpServer()).get('/api/cart')
        .set('Cookie', cookie).expect(200)).body.items).toHaveLength(0);
      expect((await orders.list(userId)).some((item) =>
        item.publicId === order.publicId)).toBe(true);
    });

    it('authenticated staff cannot read or create a customer cart', async () => {
      const staff = await db.user.create({ data: { role: 'SELLER' } });
      const token = randomBytes(32).toString('hex');
      await db.session.create({ data: {
        userId: staff.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 3600000),
      } });
      const staffCookie = SID + '=' + token;
      await request(app.getHttpServer()).get('/api/cart')
        .set('Cookie', staffCookie).expect(403);
      await request(app.getHttpServer()).post('/api/cart/change')
        .set('Cookie', staffCookie)
        .send({ revision: randomUUID(), kind: 'clear' }).expect(403);
      expect(await db.cart.count({ where: { userId: staff.id } })).toBe(0);
    });

    it('rejects checkout when the market closes after a previously open storefront status', async () => {
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const date = new Date(`${day}T00:00:00.000Z`);
      const before = await db.order.count();
      await db.shopHoursException.create({ data: { date, closed: true } });
      try {
        const response = await order('PICKUP').expect(409);
        expect(response.body.code).toBe('SHOP_CLOSED');
        expect(response.body.nextOpenAt).toEqual(expect.any(String));
        expect(await db.order.count()).toBe(before);
      } finally {
        await db.shopHoursException.delete({ where: { date } });
      }
    });

    it('migration backfills every legacy product from min without changing existing columns', async () => {
      expect(legacyProducts).toHaveLength(4);
      const result = await connection.query('SELECT * FROM "Product" WHERE id < 0 ORDER BY id');
      expect(result.rows).toEqual(legacyProducts.map((product) => ({
        ...product, portionQty: product.min, settlementMode: 'UNSET', basePrice: null,
        marketPointId: null, sourceUrl: null, sourceCheckedAt: null,
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
      expect(result.body.subtotal).toBe(385000);
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
          'marketPoint',
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
        .expect((result) => expect(result.body.subtotal).toBe(385000));
      await db.product.update({
        where: { id: productId },
        data: { price: 250000 },
      });
      const current = await quote().expect(201);
      expect(current.body.subtotal).toBe(275000);
      await order('DELIVERY', current.body.token as string).expect(400);
      const pickup = await order('PICKUP', current.body.token as string).expect(
        201,
      );
      expect(pickup.body).toMatchObject({
        subtotal: 275000,
        deliveryPrice: 0,
        total: 275000,
      });
    });
    it('price increase updates quote and makes delivery eligible for a guest', async () => {
      await db.product.update({
        where: { id: productId },
        data: { price: 250000 },
      });
      expect((await quote()).body.subtotal).toBe(275000);
      await db.product.update({
        where: { id: productId },
        data: { price: 350000 },
      });
      const current = await quote().expect(201);
      const result = await order(
        'DELIVERY',
        current.body.token as string,
      ).expect(201);
      expect(result.body).toMatchObject({
        subtotal: 385000,
        deliveryPrice: null,
        total: null,
      });
      expect(
        (
          await db.order.findUniqueOrThrow({
            where: { publicId: result.body.publicId as string },
          })
        ).userId,
      ).toBeNull();
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
        .expect((result) => expect(result.body.subtotal).toBe(275000));
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
      { price: 15000, priceQty: 500, expected: [16500, 33000, 49500] },
      { price: 19900, priceQty: 1000, expected: [10945, 21890, 32835] },
    ])('quote and persisted order agree for price=$price / priceQty=$priceQty', async ({ price, priceQty, expected }) => {
      await db.product.update({ where: { id: productId }, data: { min: 500, step: 100, portionQty: 500, price, priceQty } });
      for (const [index, qty] of [500, 1000, 1500].entries()) {
        const items = [{ productId, qty, price: 1, total: 1, step: 1, portionQty: 1 }];
        const quoted = await request(app.getHttpServer()).post('/api/orders/quote').send({ items }).expect(201);
        expect(quoted.body.subtotal).toBe(expected[index]);
        expect(quoted.body.items[0].product.portionQty).toBe(500);
        const created = await request(app.getHttpServer()).post('/api/orders').send({
          type: 'PICKUP', customerName: 'Покупатель', customerPhone: '+79990000444',
          items, quoteToken: quoted.body.token, subtotal: 1,
        }).expect(201);
        const saved = await db.order.findUniqueOrThrow({ where: { publicId: created.body.publicId as string }, include: { items: true } });
        expect(saved).toMatchObject({ subtotal: expected[index], total: expected[index] });
        expect(saved.items[0]).toMatchObject({ qty, price: customerPrice(price), priceQty, unit: 'GRAM', total: expected[index] });
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
      const checkout = (qty: number) => request(app.getHttpServer()).post('/api/orders').send({
        type: 'PICKUP', customerName: 'Покупатель', customerPhone: '+79990000444', items: [{ productId, qty }],
      });
      await checkout(501).expect(400);
      expect(await db.order.count()).toBe(before);
      const created = await checkout(700).expect(201);
      const saved = await db.order.findUniqueOrThrow({ where: { publicId: created.body.publicId as string }, include: { items: true } });
      expect(saved.items[0]).toMatchObject({ qty: 700, total: 15323 });
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
