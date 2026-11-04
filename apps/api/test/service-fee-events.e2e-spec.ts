import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { ActivityPrismaPg } from '../src/admin/activity-context.js';
import { AdminActivityInterceptor } from '../src/admin/activity.interceptor.js';
import { EventsService } from '../src/admin/events.service.js';
import { EventsCtrl } from '../src/admin/events.ctrl.js';
import { AdminUsersCtrl } from '../src/admin/users.ctrl.js';
import { AdminUsersService } from '../src/admin/users.service.js';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { SettingsCtrl } from '../src/admin/settings.ctrl.js';
import { SettingsService } from '../src/admin/settings.service.js';
import { ServiceFeeCtrl } from '../src/admin/service-fee.ctrl.js';
import { ServiceFeeService } from '../src/admin/service-fee.service.js';

const target = process.env.SERVICE_FEE_TEST_DATABASE_URL;
describe.skipIf(!target)(
  'service fee / delegated permissions / event center integration',
  () => {
    const schema = 'fee_events_' + randomUUID().replaceAll('-', '');
    let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>;
    let categoryId: number;
    const users = new Map<string, number>();
    const http = () => request(app.getHttpServer());
    const cookie = (actor = 'primary') => `${SID}=${actor}`;
    const path = '/api/admin/products/service-fee/bulk';
    const create = (override: number | null = 10) =>
      new AdminProductsService(
        db as DbService,
        new ImagesService(db as DbService),
      ).create({
        description: null,
        active: true,
        sort: 0,
        name: 'Fee event',
        slug: 'fee-event-' + randomUUID(),
        price: 10000,
        priceQty: 1,
        unit: 'PIECE',
        min: 1,
        step: 1,
        portionQty: 1,
        categoryId,
        serviceMarkupPercentOverride: override,
      });
    const preview = async (ids: number[]) => {
      const response = await http()
        .post(path + '/preview')
        .set('Cookie', cookie())
        .send({ selection: { kind: 'ids', ids }, mode: 'global' })
        .expect(201);
      return { previewToken: response.body.previewToken as string };
    };
    const changes = (productId: number) =>
      db.adminChange.findMany({ where: { productId }, orderBy: { id: 'asc' } });

    beforeAll(async () => {
      const url = new URL(target!);
      if (
        url.hostname !== '127.0.0.1' ||
        !/^\/service_fee_test_[a-f0-9]{32}$/.test(url.pathname) ||
        url.search
      )
        throw new Error('Dedicated local fee database required');
      connection = new pg.Client({ connectionString: target });
      await connection.connect();
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET search_path TO "${schema}"`);
      for (const migration of (
        await readdir(resolve('prisma/migrations'), { withFileTypes: true })
      )
        .filter((row) => row.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(
          await readFile(
            join('prisma/migrations', migration.name, 'migration.sql'),
            'utf8',
          ),
        );
      db = new PrismaClient({
        adapter: new ActivityPrismaPg(
          { connectionString: target, options: '-c search_path=' + schema },
          { schema },
        ),
      });
      vi.stubEnv('ADMIN_PHONE', '+79990000991');
      vi.stubEnv('AUTH_SECRET', 'isolated-events-' + randomUUID());
      for (const [key, role, phone] of [
        ['primary', 'ADMIN', '+79990000991'],
        ['delegate', 'ADMIN', '+79990000992'],
        ['seller', 'SELLER', '+79990000993'],
        ['owner', 'USER', '+79990000994'],
        ['buyer', 'USER', '+79990000995'],
      ] as const)
        users.set(
          key,
          (await db.user.create({ data: { role, phone, name: key } })).id,
        );
      const point = await db.marketPoint.findFirstOrThrow();
      await db.marketPointOwner.create({
        data: { userId: users.get('owner')!, marketPointId: point.id },
      });
      categoryId = (
        await db.category.create({
          data: { name: 'Fee events', slug: 'fee-events' },
        })
      ).id;
      const module = await Test.createTestingModule({
        controllers: [
          AdminUsersCtrl,
          AdminProductsCtrl,
          SettingsCtrl,
          ServiceFeeCtrl,
          EventsCtrl,
        ],
        providers: [
          { provide: DbService, useValue: db },
          AdminUsersService,
          AdminProductsService,
          ImagesService,
          SettingsService,
          ServiceFeeService,
          EventsService,
          { provide: APP_INTERCEPTOR, useClass: AdminActivityInterceptor },
          {
            provide: AuthService,
            useValue: {
              me: async (token: string) =>
                users.has(token)
                  ? db.user.findUnique({
                      where: { id: users.get(token)! },
                      include: {
                        ownedPoints: { select: { marketPointId: true } },
                      },
                    })
                  : null,
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
    }, 60000);
    beforeEach(async () => {
      await db.serviceFeeBulkOperation.deleteMany();
      await db.product.deleteMany();
      await db.shopSettings.update({
        where: { id: 1 },
        data: { globalServiceMarkupPercent: 10 },
      });
      await db.adminAudit.deleteMany();
      await db.adminChange.deleteMany();
    });
    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
      if (connection) {
        await connection.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await connection.end();
      }
      vi.unstubAllEnvs();
    });

    it('uses real primary permissions and rejects delegated, seller, owner, buyer and guest writes', async () => {
      const item = await create();
      const signed = await preview([item.id]);
      expect(
        (
          await http()
            .get('/api/admin/users/permissions')
            .set('Cookie', cookie())
            .expect(200)
        ).body.primaryAdmin,
      ).toBe(true);
      expect(
        (
          await http()
            .get('/api/admin/users/permissions')
            .set('Cookie', cookie('delegate'))
            .expect(200)
        ).body.primaryAdmin,
      ).toBe(false);
      for (const actor of ['delegate', 'seller', 'owner', 'buyer', 'guest']) {
        await http()
          .patch('/api/admin/settings')
          .set('Cookie', cookie(actor))
          .send({ globalServiceMarkupPercent: 15 })
          .expect(403);
        await http()
          .post(path + '/preview')
          .set('Cookie', cookie(actor))
          .send({ selection: { kind: 'ids', ids: [item.id] }, mode: 'global' })
          .expect(403);
        await http()
          .post(path + '/apply')
          .set('Cookie', cookie(actor))
          .send({ ...signed, requestId: randomUUID(), confirmed: true })
          .expect(403);
      }
      expect(await changes(item.id)).toHaveLength(0);
      expect(await db.adminAudit.count()).toBe(0);
      expect(await db.serviceFeeBulkOperation.count()).toBe(0);
    });

    it('records individual10 to global10 and back with actor and unchanged customer price', async () => {
      const item = await create();
      for (const override of [null, 10])
        await http()
          .patch('/api/admin/products/' + item.id)
          .set('Cookie', cookie())
          .send({ serviceMarkupPercentOverride: override })
          .expect(200);
      const events = await changes(item.id);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        actorId: users.get('primary'),
        ownerOnly: true,
        beforeValue: { serviceMarkupPercentOverride: 10 },
        afterValue: { serviceMarkupPercentOverride: null },
      });
      expect(events[1]).toMatchObject({
        beforeValue: { serviceMarkupPercentOverride: null },
        afterValue: { serviceMarkupPercentOverride: 10 },
      });
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: item.id } }))
          .serviceMarkupPercent,
      ).toBe(10);
      expect(await db.adminAudit.count()).toBe(2);
      const delegateFeed = await http()
        .get('/api/admin/events')
        .set('Cookie', cookie('delegate'))
        .expect(200);
      expect(delegateFeed.body.items).toHaveLength(0);
      expect(
        (
          await http()
            .get('/api/admin/events')
            .set('Cookie', cookie())
            .expect(200)
        ).body.items,
      ).toHaveLength(2);
    });

    it('preserves individual zero in the event projection and server price', async () => {
      const item = await create();
      const response = await http()
        .patch('/api/admin/products/' + item.id)
        .set('Cookie', cookie())
        .send({ serviceMarkupPercentOverride: 0 })
        .expect(200);
      expect(response.body).toMatchObject({
        serviceMarkupPercentOverride: 0,
        serviceMarkupPercent: 0,
        customerPrice: 10000,
      });
      expect((await changes(item.id))[0]).toMatchObject({
        beforeValue: {
          serviceMarkupPercentOverride: 10,
          serviceMarkupPercent: 10,
        },
        afterValue: {
          serviceMarkupPercentOverride: 0,
          serviceMarkupPercent: 0,
        },
      });
    });

    it('records global changes even with no global products and preserves individual prices', async () => {
      const item = await create(0);
      await http()
        .patch('/api/admin/settings')
        .set('Cookie', cookie())
        .send({ globalServiceMarkupPercent: 15 })
        .expect(200);
      const event = await db.adminChange.findFirstOrThrow({
        where: { entity: 'ShopSettings' },
      });
      expect(event).toMatchObject({
        actorId: users.get('primary'),
        ownerOnly: true,
        beforeValue: { globalServiceMarkupPercent: 10 },
        afterValue: { globalServiceMarkupPercent: 15 },
      });
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: item.id } }))
          .serviceMarkupPercent,
      ).toBe(0);
      expect(await changes(item.id)).toHaveLength(0);
    });

    it('projects a bulk once and replays the committed result after a discarded response without duplicate audit/events', async () => {
      const items = await Promise.all([create(), create(0), create(20)]);
      await db.product.update({
        where: { id: items[0]!.id },
        data: { serviceMarkupNeedsReview: true },
      });
      const signed = await preview(items.map((item) => item.id));
      const body = { ...signed, requestId: randomUUID(), confirmed: true };
      const committed = await http()
        .post(path + '/apply')
        .set('Cookie', cookie())
        .send(body)
        .expect(201);
      const products = await db.product.findMany({ orderBy: { id: 'asc' } });
      const audit = await db.adminAudit.findMany({ orderBy: { id: 'asc' } });
      const events = await db.adminChange.findMany({ orderBy: { id: 'asc' } });
      expect(audit).toHaveLength(3);
      expect(events).toHaveLength(3);
      expect(
        events.find((event) => event.productId === items[0]!.id),
      ).toMatchObject({
        beforeValue: { serviceMarkupNeedsReview: true },
        afterValue: { serviceMarkupNeedsReview: false },
      });
      expect(
        events.every(
          (event) => event.actorId === users.get('primary') && event.ownerOnly,
        ),
      ).toBe(true);
      expect(events.map((event) => event.requestId)).toEqual(
        Array(3).fill(events[0]!.requestId),
      );
      expect(
        audit.every((row) =>
          JSON.stringify(row.newValue).includes(body.requestId),
        ),
      ).toBe(true);
      const replay = await http()
        .post(path + '/apply')
        .set('Cookie', cookie())
        .send(body)
        .expect(201);
      expect(replay.body).toEqual(committed.body);
      expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual(
        products,
      );
      expect(await db.adminAudit.findMany({ orderBy: { id: 'asc' } })).toEqual(
        audit,
      );
      expect(await db.adminChange.findMany({ orderBy: { id: 'asc' } })).toEqual(
        events,
      );
      expect(await db.serviceFeeBulkOperation.count()).toBe(1);
    });

    it('rolls back Product, AdminAudit and projected events if durable-result storage fails, recording only a private system error', async () => {
      const item = await create();
      const signed = await preview([item.id]);
      await connection.query(`CREATE FUNCTION fail_fee_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture result failure'; END; $$;
      CREATE TRIGGER fail_result BEFORE INSERT ON "ServiceFeeBulkOperation" FOR EACH ROW EXECUTE FUNCTION fail_fee_result()`);
      try {
        await http()
          .post(path + '/apply')
          .set('Cookie', cookie())
          .send({ ...signed, requestId: randomUUID(), confirmed: true })
          .expect(500);
        expect(
          await db.product.findUniqueOrThrow({ where: { id: item.id } }),
        ).toMatchObject({ serviceMarkupPercentOverride: 10 });
        expect(await changes(item.id)).toHaveLength(0);
        expect(await db.adminAudit.count()).toBe(0);
        expect(await db.serviceFeeBulkOperation.count()).toBe(0);
        await vi.waitFor(async () =>
          expect(
            await db.adminChange.count({
              where: { operation: 'ERROR', ownerOnly: true },
            }),
          ).toBe(1),
        );
        const error = await db.adminChange.findFirstOrThrow({
          where: { operation: 'ERROR' },
        });
        expect(error.afterValue).toEqual({ code: 'INTERNAL_ERROR' });
        expect(
          JSON.stringify([error.title, error.beforeValue, error.afterValue]),
        ).not.toContain(signed.previewToken);
      } finally {
        await connection.query(
          'DROP TRIGGER fail_result ON "ServiceFeeBulkOperation"; DROP FUNCTION fail_fee_result()',
        );
      }
    });
  },
);
