import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { PrismaClient } from '../src/db/gen/client.js';
import {
  ActivityPrismaPg,
  withAdminActivity,
} from '../src/admin/activity-context.js';
import { AdminUsersService } from '../src/admin/users.service.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { EventsService } from '../src/admin/events.service.js';
import { EventsCtrl } from '../src/admin/events.ctrl.js';
import { AdminActivityCtrl } from '../src/admin/activity.ctrl.js';
import { AdminActivityService } from '../src/admin/activity.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { DbService } from '../src/db/db.service.js';
import {
  Body,
  Controller,
  Inject,
  Param,
  Patch,
  StandardSchemaValidationPipe,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AdminGuard } from '../src/auth/admin.guard.js';
import { SID } from '../src/auth/auth.service.js';
import { AdminUsersCtrl } from '../src/admin/users.ctrl.js';
import { AdminActivityInterceptor } from '../src/admin/activity.interceptor.js';
import { DbService as Database } from '../src/db/db.service.js';

@Controller('audit-test')
@UseGuards(AdminGuard)
class ActivityTestCtrl {
  constructor(@Inject(Database) private readonly db: DbService) {}
  @Patch('products/:id')
  update(@Param('id') id: string, @Body() body: { description: string }) {
    return this.db.product.update({
      where: { id: Number(id) },
      data: { description: body.description },
    });
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Delegated administrators and committed notification outbox',
  () => {
    const schema = 'delegated_admin_test_' + randomUUID().replaceAll('-', '');
    let connection: pg.Client,
      db: PrismaClient,
      users: AdminUsersService,
      auth: AuthService,
      activity: AdminActivityService;
    let primary: number, delegate: number, buyer: number, product: number;
    const primaryPhone = '+79990000901',
      delegatePhone = '+79990000902';
    const password = 'Delegate-' + randomUUID();
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        !url.pathname.slice(1).startsWith('korzina_e2e')
      )
        throw new Error('Use an isolated local korzina_e2e database');
      connection = new pg.Client({ connectionString: url.toString() });
      await connection.connect();
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET search_path TO "${schema}"`);
      for (const entry of (
        await readdir(resolve('prisma/migrations'), { withFileTypes: true })
      )
        .filter((x) => x.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(
          await readFile(
            join('prisma/migrations', entry.name, 'migration.sql'),
            'utf8',
          ),
        );
      db = new PrismaClient({
        adapter: new ActivityPrismaPg(
          {
            connectionString: url.toString(),
            options: '-c search_path=' + schema,
          },
          { schema },
        ),
      });
      vi.stubEnv('AUTH_SECRET', 'test-' + randomUUID());
      users = new AdminUsersService(db as DbService);
      auth = new AuthService(db as DbService);
      activity = new AdminActivityService(db as DbService);
      primary = (
        await db.user.create({
          data: { phone: primaryPhone, role: 'ADMIN', name: 'Основной' },
        })
      ).id;
      delegate = (
        await db.user.create({
          data: { phone: delegatePhone, role: 'USER', name: 'Другой админ' },
        })
      ).id;
      buyer = (
        await db.user.create({ data: { phone: '+79990000903', role: 'USER' } })
      ).id;
      const category = await db.category.create({
        data: { name: 'Тест', slug: 'test' },
      });
      product = (
        await db.product.create({
          data: {
            name: 'Товар',
            slug: 'item',
            categoryId: category.id,
            price: 10000,
            priceQty: 1,
            unit: 'PIECE',
            step: 1,
            min: 1,
            portionQty: 1,
          },
        })
      ).id;
    }, 60000);
    beforeEach(() => {
      vi.stubEnv('ADMIN_PHONE', primaryPhone);
      vi.stubEnv('ADMIN_PASSWORD', 'Primary-' + password);
      vi.stubEnv('AUTH_SECRET', 'test-' + randomUUID());
      vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', '123456:local_test_only');
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      await db?.$disconnect();
      if (connection) {
        await connection.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await connection.end();
      }
    }, 30000);
    it('only the primary account can grant ADMIN; credentials and session revocation work', async () => {
      await db.staffTelegramLinkCode.create({
        data: {
          userId: delegate,
          codeHash: 'stale-before-grant',
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await users.role(delegate, 'ADMIN', primary, password);
      const beforeReset = await auth.adminLogin(delegatePhone, password);
      await users.role(delegate, 'ADMIN', primary, password + '-reset');
      expect(await auth.me(beforeReset.token)).toBeNull();
      await expect(
        auth.adminLogin(delegatePhone, password),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        (await auth.adminLogin(delegatePhone, password + '-reset')).user.role,
      ).toBe('ADMIN');
      await users.role(delegate, 'ADMIN', primary, password);
      expect(
        await db.staffTelegramLinkCode.count({ where: { userId: delegate } }),
      ).toBe(0);
      const user = await db.user.findUniqueOrThrow({ where: { id: delegate } });
      expect(user.adminPasswordHash).not.toContain(password);
      expect(user.adminPasswordHash).toMatch(/^scrypt:/);
      const login = await auth.adminLogin(delegatePhone, password);
      expect(login.user.role).toBe('ADMIN');
      expect(JSON.stringify(login.user)).not.toContain('adminPasswordHash');
      expect((await auth.me(login.token))?.id).toBe(delegate);
      await expect(
        auth.adminLogin(delegatePhone, 'incorrect'),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        users.role(buyer, 'ADMIN', delegate, password),
      ).rejects.toMatchObject({ status: 403 });
      await expect(users.role(buyer, 'SELLER', delegate)).rejects.toMatchObject(
        { status: 403 },
      );
      await expect(users.points(buyer, [], delegate)).rejects.toMatchObject({
        status: 403,
      });
      await expect(users.role(primary, 'USER', primary)).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        users.role(delegate, 'USER', delegate),
      ).rejects.toMatchObject({ status: 403 });
      await auth.adminLogin(primaryPhone, 'Primary-' + password);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: delegate } })).role,
      ).toBe('ADMIN');
      expect((await auth.me(login.token))?.id).toBe(delegate);
      await users.role(delegate, 'USER', primary);
      expect(await auth.me(login.token)).toBeNull();
      await users.role(delegate, 'ADMIN', primary, password);
    });
    it('captures actual authenticated HTTP writes and denies delegated grants through HTTP', async () => {
      const module = await Test.createTestingModule({
        controllers: [ActivityTestCtrl, AdminUsersCtrl],
        providers: [
          AdminGuard,
          { provide: Database, useValue: db },
          { provide: AuthService, useValue: auth },
          { provide: AdminUsersService, useValue: users },
          {
            provide: EventsService,
            useValue: new EventsService(db as DbService),
          },
          { provide: APP_INTERCEPTOR, useClass: AdminActivityInterceptor },
        ],
      }).compile();
      const app = module.createNestApplication();
      app.use(cookieParser());
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
      await app.init();
      try {
        const login = await auth.adminLogin(delegatePhone, password);
        const primaryLogin = await auth.adminLogin(
          primaryPhone,
          'Primary-' + password,
        );
        const count = await db.adminChange.count();
        await request(app.getHttpServer())
          .patch('/api/audit-test/products/' + product)
          .set('Cookie', `${SID}=${login.token}`)
          .send({ description: 'HTTP изменение' })
          .expect(200);
        const row = await db.adminChange.findFirstOrThrow({
          orderBy: { id: 'desc' },
        });
        expect(row).toMatchObject({
          actorId: delegate,
          source: 'WEB',
          afterValue: { description: 'HTTP изменение' },
        });
        await request(app.getHttpServer())
          .patch('/api/audit-test/products/' + product)
          .set('Cookie', `${SID}=${primaryLogin.token}`)
          .send({ description: 'Основной админ' })
          .expect(200);
        expect(await db.adminChange.count()).toBe(count + 2);
        expect(
          await db.adminChange.count({
            where: { notifyOwner: false, actorId: primary },
          }),
        ).toBeGreaterThan(0);
        await request(app.getHttpServer())
          .patch(`/api/admin/users/${buyer}/role`)
          .set('Cookie', `${SID}=${login.token}`)
          .send({ role: 'ADMIN', password })
          .expect(403);
        await request(app.getHttpServer())
          .patch('/api/audit-test/products/' + product)
          .send({ description: 'Без входа' })
          .expect(403);
      } finally {
        await app.close();
      }
    });
    it('commits row differences with raw, transactional and bulk writes, without recording the primary account', async () => {
      const initial = await db.adminChange.count();
      await db.product.update({
        where: { id: product },
        data: { price: 11000 },
      });
      expect(await db.adminChange.count()).toBe(initial);
      await withAdminActivity(delegate, 'WEB', () =>
        db.$transaction(async (tx) => {
          await tx.product.update({
            where: { id: product },
            data: { price: 12000 },
          });
          await tx.$executeRaw`UPDATE "Product" SET name='Новое название' WHERE id=${product}`;
        }),
      );
      const events = await db.adminChange.findMany({
        where: { actorId: delegate, id: { gt: initial } },
        orderBy: { id: 'asc' },
      });
      expect(events).toHaveLength(2);
      expect(events[0]?.requestId).toBe(events[1]?.requestId);
      expect(events[0]).toMatchObject({
        beforeValue: { price: 11000 },
        afterValue: { price: 12000 },
        source: 'WEB',
        status: 'PENDING',
      });
      expect(events[1]?.afterValue).toEqual({ name: 'Новое название' });
      await expect(
        withAdminActivity(delegate, 'WEB', () =>
          db.$transaction(async (tx) => {
            await tx.product.update({
              where: { id: product },
              data: { price: 13000 },
            });
            throw new Error('rollback');
          }),
        ),
      ).rejects.toThrow('rollback');
      expect(await db.adminChange.count()).toBe(initial + 2);
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: product } })).price,
      ).toBe(12000);
    });
    it('keeps actor contexts separate across concurrent pooled queries and redacts authentication fields', async () => {
      const another = await db.user.create({
        data: { phone: '+79990000904', name: 'Админ 2', role: 'ADMIN' },
      });
      await Promise.all([
        withAdminActivity(delegate, 'TELEGRAM', () =>
          db.product.update({
            where: { id: product },
            data: { description: 'Первый' },
          }),
        ),
        withAdminActivity(another.id, 'WEB', () =>
          db.product.update({ where: { id: product }, data: { sort: 12 } }),
        ),
      ]);
      const rows = await db.adminChange.findMany({
        where: { actorId: { in: [delegate, another.id] } },
        orderBy: { id: 'desc' },
        take: 2,
      });
      expect(rows.find((x) => x.actorId === delegate)?.source).toBe('TELEGRAM');
      expect(rows.find((x) => x.actorId === another.id)?.source).toBe('WEB');
      await withAdminActivity(delegate, 'WEB', () =>
        db.user.update({
          where: { id: delegate },
          data: { adminPasswordHash: 'private-secret-hash' },
        }),
      );
      const passwordEvent = await db.adminChange.findFirstOrThrow({
        where: { entity: 'User' },
        orderBy: { id: 'desc' },
      });
      expect(
        JSON.stringify(passwordEvent, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ).not.toContain('private-secret-hash');
      expect(passwordEvent.afterValue).toEqual({ adminPasswordChanged: true });
    });
    it('refuses a revoked actor and leaves the business row unchanged', async () => {
      const before = await db.product.findUniqueOrThrow({
        where: { id: product },
      });
      await db.user.update({ where: { id: delegate }, data: { role: 'USER' } });
      await expect(
        withAdminActivity(delegate, 'WEB', () =>
          db.product.update({ where: { id: product }, data: { price: 99999 } }),
        ),
      ).rejects.toThrow();
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: product } })).price,
      ).toBe(before.price);
      await db.user.update({
        where: { id: delegate },
        data: { role: 'ADMIN' },
      });
    });
    it('notifies only the primary admin and retains an unconfirmed send without automatic duplication', async () => {
      await db.staffTelegramIdentity.create({
        data: {
          userId: primary,
          telegramUserId: 900001n,
          botStartedAt: new Date(),
        },
      });
      await db.adminChange.updateMany({
        data: { createdAt: new Date(Date.now() - 10000) },
      });
      vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
      vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', '');
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('transport unavailable'));
      vi.stubGlobal('fetch', fetcher);
      await activity.tick();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).chat_id).toBe(
        900001,
      );
      expect(
        await db.adminChange.count({ where: { status: 'UNKNOWN' } }),
      ).toBeGreaterThan(0);
      await db.adminChange.updateMany({
        where: { status: 'PENDING' },
        data: { nextAttemptAt: new Date(Date.now() + 60000) },
      });
      await activity.tick();
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(activity.list(delegate, 1)).rejects.toMatchObject({
        status: 403,
      });
      const item = await db.adminChange.findFirstOrThrow({
        where: { status: 'UNKNOWN' },
      });
      await expect(activity.retry(delegate, item.id)).rejects.toMatchObject({
        status: 403,
      });
      await activity.retry(primary, item.id);
      fetcher.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
          status: 200,
        }),
      );
      await activity.tick();
      expect(
        await db.adminChange.count({
          where: { requestId: item.requestId, status: 'SENT' },
        }),
      ).toBeGreaterThan(0);
    });

    it('records owner, seller, customer, receipt and real payment events while excluding personal data', async () => {
      const feed = new EventsService(db as DbService);
      const seller = await db.user.create({
        data: { role: 'SELLER', name: 'Сборщик' },
      });
      await withAdminActivity(
        seller.id,
        'TELEGRAM',
        () =>
          db.product.update({ where: { id: product }, data: { price: 14500 } }),
        false,
        'SELLER',
      );
      await withAdminActivity(
        primary,
        'WEB',
        () =>
          db.product.update({ where: { id: product }, data: { price: 15000 } }),
        false,
      );
      await withAdminActivity(
        primary,
        'WEB',
        () => users.role(delegate, 'ADMIN', primary, password),
        false,
      );
      const order = await withAdminActivity(
        buyer,
        'WEB',
        () =>
          db.order.create({
            data: {
              type: 'PICKUP',
              userId: buyer,
              customerName: 'Private Customer',
              customerPhone: '+79998887766',
              street: 'Private Street',
              comment: 'secret order note',
              items: {
                create: {
                  productId: product,
                  productName: 'Товар',
                  productSlug: 'item',
                  price: 15000,
                  priceQty: 1,
                  unit: 'PIECE',
                  qty: 1,
                },
              },
            },
          }),
        false,
        'USER',
      );
      await withAdminActivity(
        seller.id,
        'TELEGRAM',
        () =>
          db.order.update({
            where: { id: order.id },
            data: { status: 'CONFIRMED' },
          }),
        false,
        'SELLER',
      );
      await withAdminActivity(
        seller.id,
        'WEB',
        () =>
          db.orderItem.updateMany({
            where: { orderId: order.id },
            data: { actualQty: 2, actualTotal: 30000 },
          }),
        false,
        'SELLER',
      );
      const payment = await db.orderPayment.create({
        data: { orderId: order.id, amount: 30000 },
      });
      expect(
        await db.adminChange.count({
          where: { orderId: order.id, title: 'Оплата подтверждена' },
        }),
      ).toBe(0);
      await withAdminActivity(
        seller.id,
        'WEB',
        () =>
          db.orderPayment.update({
            where: { id: payment.id },
            data: { status: 'PAID', confirmedById: seller.id },
          }),
        false,
        'SELLER',
      );
      const scoped = await feed.list(delegate, { orderId: order.id });
      expect(scoped.items.some((x) => x.category === 'RECEIPTS')).toBe(true);
      expect(scoped.items.some((x) => x.title === 'Оплата подтверждена')).toBe(
        true,
      );
      expect(
        scoped.items.find((x) => x.title === 'Заказ создан'),
      ).toMatchObject({ actorRole: 'CUSTOMER', actorId: buyer });
      expect(
        scoped.items.find(
          (x) =>
            x.afterValue &&
            typeof x.afterValue === 'object' &&
            !Array.isArray(x.afterValue) &&
            x.afterValue.status === 'CONFIRMED',
        ),
      ).toMatchObject({
        actorId: seller.id,
        actorRole: 'SELLER',
        source: 'TELEGRAM',
      });
      const json = JSON.stringify(scoped);
      for (const privateValue of [
        'Private Customer',
        '79998887766',
        'Private Street',
        'secret order note',
        'adminPasswordHash',
        'claimToken',
        'leaseUntil',
      ])
        expect(json).not.toContain(privateValue);
      const owner = await feed.list(primary, {}),
        delegated = await feed.list(delegate, {});
      expect(owner.items.some((x) => x.ownerOnly)).toBe(true);
      expect(delegated.items.every((x) => !x.ownerOnly)).toBe(true);
      expect(
        (await feed.list(delegate, { category: 'SELLERS', actorId: seller.id }))
          .items,
      ).toHaveLength(1);
      expect(
        (await feed.list(delegate, { q: 'сборщик' })).items.length,
      ).toBeGreaterThan(0);
      const oldest = scoped.items.at(-1)!;
      expect(
        (await feed.list(delegate, { orderId: order.id, before: oldest.id }))
          .items,
      ).toHaveLength(0);
      await db.orderNotification.create({
        data: {
          orderId: order.id,
          type: 'ORDER_CONFIRMED',
          channel: 'TELEGRAM',
          dedupeKey: 'events-failure',
        },
      });
      const notification = await db.orderNotification.findFirstOrThrow({
        where: { orderId: order.id },
      });
      await db.orderNotification.update({
        where: { id: notification.id },
        data: { status: 'SENDING' },
      });
      expect(
        await db.adminChange.count({
          where: {
            entity: 'OrderNotification',
            entityId: String(notification.id),
          },
        }),
      ).toBe(0);
      await db.orderNotification.update({
        where: { id: notification.id },
        data: { status: 'FAILED', error: 'TELEGRAM_RETRYABLE' },
      });
      expect(
        (await feed.list(delegate, { category: 'SYSTEM', orderId: order.id }))
          .items,
      ).toHaveLength(1);
    });
    it('records photo visibility, map geometry, slide content and catalogue controls', async () => {
      const image = await db.productImage.create({
        data: { productId: product, url: '/uploads/products/fixture.webp' },
      });
      const point = await db.marketPoint.create({
        data: {
          slug: 'fixture-point',
          name: 'Точка',
          kind: 'STALL',
          mapX: 20,
          mapY: 30,
        },
      });
      const slide = await db.homeSlide.create({
        data: {
          type: 'PERMANENT',
          title: 'Слайд',
          text: 'Старый текст',
          buttonLabel: 'Каталог',
          to: '/catalog',
        },
      });
      await withAdminActivity(
        primary,
        'WEB',
        () =>
          db.$transaction(async (tx) => {
            await tx.productImage.update({
              where: { id: image.id },
              data: { visible: false },
            });
            await tx.marketPoint.update({
              where: { id: point.id },
              data: { mapX: 40, isPublished: true },
            });
            await tx.homeSlide.update({
              where: { id: slide.id },
              data: { text: 'Новая информация' },
            });
            await tx.product.update({
              where: { id: product },
              data: { hitMode: 'MANUAL' },
            });
          }),
        false,
      );
      for (const [entity, field, value] of [
        ['ProductImage', 'visible', false],
        ['MarketPoint', 'mapX', 40],
        ['HomeSlide', 'text', 'Новая информация'],
        ['Product', 'hitMode', 'MANUAL'],
      ] as const) {
        const row = await db.adminChange.findFirstOrThrow({
          where: { entity, actorId: primary },
          orderBy: { id: 'desc' },
        });
        expect(row.afterValue).toHaveProperty(field, value);
        expect(row.notifyOwner).toBe(false);
      }
    });
    it('resumes across out-of-order commits, without publishing rollbacks or duplicate deliveries', async () => {
      const feed = new EventsService(db as DbService);
      const base = await feed.list(delegate, {});
      let ready!: () => void, release!: () => void;
      const allocated = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayed = withAdminActivity(delegate, 'WEB', () =>
        db.$transaction(
          async (tx) => {
            await tx.product.update({
              where: { id: product },
              data: { description: 'Late commit' },
            });
            ready();
            await hold;
          },
          { timeout: 20000 },
        ),
      );
      await allocated;
      const category = await db.category.create({
        data: { name: 'Другой', slug: 'other' },
      });
      try {
        await withAdminActivity(delegate, 'WEB', () =>
          db.category.update({
            where: { id: category.id },
            data: { name: 'Fast commit' },
          }),
        );
        const first = await feed.changes(delegate, {}, base.cursor);
        expect(first.count).toBe(1);
        release();
        await delayed;
        const second = await feed.changes(delegate, {}, first.cursor);
        expect(second.count).toBe(1);
        expect((await feed.changes(delegate, {}, second.cursor)).count).toBe(0);
        await expect(
          withAdminActivity(delegate, 'WEB', () =>
            db.$transaction(async (tx) => {
              await tx.category.update({
                where: { id: category.id },
                data: { name: 'Rolled back' },
              });
              throw new Error('rollback');
            }),
          ),
        ).rejects.toThrow('rollback');
        expect((await feed.changes(delegate, {}, second.cursor)).count).toBe(0);
      } finally {
        release();
        await delayed;
      }
    });
    it('enforces API and SSE access, reconnect cursors and revocation on an open stream', async () => {
      await users.role(delegate, 'ADMIN', primary, password);
      const feed = new EventsService(db as DbService);
      const module = await Test.createTestingModule({
        controllers: [EventsCtrl, AdminActivityCtrl],
        providers: [
          AdminGuard,
          { provide: AuthService, useValue: auth },
          { provide: EventsService, useValue: feed },
          { provide: AdminActivityService, useValue: activity },
        ],
      }).compile();
      const app = module.createNestApplication();
      app.use(cookieParser());
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
      await app.listen(0, '127.0.0.1');
      const server = app.getHttpServer();
      const login = await auth.adminLogin(delegatePhone, password);
      const owner = await auth.adminLogin(primaryPhone, 'Primary-' + password);
      const cookie = `${SID}=${login.token}`;
      const base = await feed.list(delegate, {});
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await request(server).get('/api/admin/events').expect(403);
        await request(server).get('/api/admin/events/stream').expect(403);
        await request(server)
          .get('/api/admin/events?category=SECURITY')
          .set('Cookie', cookie)
          .expect(400);
        await request(server)
          .get('/api/admin/activity')
          .set('Cookie', `${SID}=${owner.token}`)
          .expect(200);
        await request(server)
          .get('/api/admin/activity')
          .set('Cookie', cookie)
          .expect(403);
        const response = await request(server)
          .get('/api/admin/events?ownerOnly=true')
          .set('Cookie', cookie)
          .expect(200);
        expect(
          response.body.items.every(
            (x: { ownerOnly: boolean }) => !x.ownerOnly,
          ),
        ).toBe(true);
        await withAdminActivity(delegate, 'WEB', () =>
          db.product.update({
            where: { id: product },
            data: { description: 'Missed while disconnected' },
          }),
        );
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('No test port');
        const stream = await fetch(
          `http://127.0.0.1:${address.port}/api/admin/events/stream`,
          { headers: { Cookie: cookie, 'Last-Event-ID': base.cursor } },
        );
        expect(stream.headers.get('content-type')).toContain(
          'text/event-stream',
        );
        reader = stream.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        while (!text.includes('event: sync')) {
          const chunk = await reader.read();
          text += decoder.decode(chunk.value);
        }
        expect(text).toContain('"count":1');
        expect(text).not.toContain('ownerOnly');
        await users.role(delegate, 'USER', primary);
        while (!text.includes('event: denied')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value);
        }
        expect(text).toContain('event: denied');
        await request(server)
          .get('/api/admin/events')
          .set('Cookie', cookie)
          .expect(403);
      } finally {
        await reader?.cancel();
        await app.close();
        await users.role(delegate, 'ADMIN', primary, password);
      }
    }, 15000);

    it('authenticates through the real HTTP login and revokes its HttpOnly cookie on password reset', async () => {
      await users.role(delegate, 'ADMIN', primary, password);
      const module = await Test.createTestingModule({
        imports: [AuthModule],
        controllers: [EventsCtrl],
        providers: [
          {
            provide: EventsService,
            useValue: new EventsService(db as DbService),
          },
        ],
      })
        .overrideProvider(Database)
        .useValue(db)
        .compile();
      const app = module.createNestApplication();
      app.use(cookieParser());
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
      await app.init();
      try {
        const server = app.getHttpServer();
        const login = await request(server)
          .post('/api/auth/admin/login')
          .send({ phone: delegatePhone, password })
          .expect(201);
        const headers = login.headers['set-cookie'] as unknown as string[];
        expect(headers[0]).toContain('HttpOnly');
        expect(headers[0]).toContain(`${SID}=`);
        expect(login.body.role).toBe('ADMIN');
        expect(JSON.stringify(login.body)).not.toContain('adminPasswordHash');
        const cookie = headers[0]!.split(';')[0]!;
        await request(server)
          .get('/api/admin/events')
          .set('Cookie', cookie)
          .expect(200);
        await users.role(delegate, 'ADMIN', primary, password + '-http-reset');
        await request(server)
          .get('/api/admin/events')
          .set('Cookie', cookie)
          .expect(403);
        await request(server)
          .post('/api/auth/admin/login')
          .send({ phone: delegatePhone, password })
          .expect(401);
        await request(server)
          .post('/api/auth/admin/login')
          .send({ phone: delegatePhone, password: password + '-http-reset' })
          .expect(201);
      } finally {
        await app.close();
        await users.role(delegate, 'ADMIN', primary, password);
      }
    });
    it('deduplicates explicit failure events and bounds retention without deleting unresolved sends', async () => {
      const feed = new EventsService(db as DbService),
        requestId = randomUUID();
      await feed.failure(
        requestId,
        { id: primary, role: 'ADMIN', name: 'Владелец' },
        true,
      );
      await feed.failure(
        requestId,
        { id: primary, role: 'ADMIN', name: 'Владелец' },
        true,
      );
      expect(await db.adminChange.count({ where: { requestId } })).toBe(1);
      const old = new Date(Date.now() - 200 * 86400000);
      const done = await db.adminChange.create({
        data: {
          requestId: randomUUID(),
          actorId: null,
          actorName: 'Система',
          actorRole: 'SYSTEM',
          source: 'SYSTEM',
          category: 'SYSTEM',
          title: 'История',
          entity: 'System',
          entityId: 'old',
          operation: 'ERROR',
          notifyOwner: false,
          status: 'SENT',
          createdAt: old,
        },
      });
      const unresolved = await db.adminChange.create({
        data: {
          requestId: randomUUID(),
          actorId: delegate,
          actorName: 'Администратор',
          source: 'WEB',
          entity: 'Product',
          entityId: 'old-unknown',
          operation: 'UPDATE',
          status: 'UNKNOWN',
          createdAt: old,
        },
      });
      expect(await feed.retain()).toBe(1);
      expect(
        await db.adminChange.findUnique({ where: { id: done.id } }),
      ).toBeNull();
      expect(
        await db.adminChange.findUnique({ where: { id: unresolved.id } }),
      ).not.toBeNull();
    });
    it('preserves old journal records while applying the additive event migration', async () => {
      const upgrade =
        'delegated_admin_upgrade_' + randomUUID().replaceAll('-', '');
      await connection.query(`CREATE SCHEMA "${upgrade}"`);
      try {
        await connection.query(`SET search_path TO "${upgrade}"`);
        const migrations = (
          await readdir(resolve('prisma/migrations'), { withFileTypes: true })
        )
          .filter((x) => x.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name));
        const latest = migrations.at(-1)!;
        for (const migration of migrations.slice(0, -1))
          await connection.query(
            await readFile(
              join('prisma/migrations', migration.name, 'migration.sql'),
              'utf8',
            ),
          );
        await connection.query(
          `INSERT INTO "AdminChange"(id,"requestId","actorId","actorName",source,entity,"entityId",operation,"beforeValue","afterValue",status)
          VALUES(1,$1,999,'+79990000000','WEB','Product','24','UPDATE','{"price":100,"customerPhone":"private","tokenHash":"secret"}','{"price":200,"comment":"private"}','UNKNOWN')`,
          [randomUUID()],
        );
        await connection.query(
          `INSERT INTO "AdminChange"(id,"requestId","actorId","actorName",source,entity,"entityId",operation,"beforeValue","afterValue",status)
          VALUES(2,$1,998,'Анна','WEB','Product','25','UPDATE','{"price":300,"description":{"secret":"sensitive-old"}}','{"price":400,"description":{"secret":"sensitive-new"}}','SENT')`,
          [randomUUID()],
        );
        await connection.query(
          await readFile(
            join('prisma/migrations', latest.name, 'migration.sql'),
            'utf8',
          ),
        );
        const result = await connection.query(
          'SELECT id,status,"actorName","beforeValue","afterValue" FROM "AdminChange" ORDER BY id',
        );
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual({
          id: 1,
          status: 'UNKNOWN',
          actorName: 'Администратор #999',
          beforeValue: { price: 100 },
          afterValue: { price: 200 },
        });

        const nestedObject = {
          type: 'object',
          bytes: expect.any(Number),
          fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
        };

        expect(result.rows[1]).toMatchObject({
          id: 2,
          status: 'SENT',
          actorName: 'Анна',
          beforeValue: { price: 300, description: nestedObject },
          afterValue: { price: 400, description: nestedObject },
        });
        expect(JSON.stringify(result.rows[1])).not.toContain('sensitive-');

        const nested = await connection.query(
          "SELECT event_values($1::jsonb, 'HomeSlide') AS value",
          [JSON.stringify({
            text: 'Пример',
            content: [{ secret: 'sensitive-array' }],
          })],
        );

        expect(nested.rows[0].value).toMatchObject({
          text: 'Пример',
          content: {
            type: 'array',
            bytes: expect.any(Number),
            fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
          },
        });
        expect(JSON.stringify(nested.rows[0])).not.toContain('sensitive-array');
      } finally {
        await connection.query(`SET search_path TO "${schema}"`);
        await connection.query(`DROP SCHEMA "${upgrade}" CASCADE`);
      }
    });
  },
);
