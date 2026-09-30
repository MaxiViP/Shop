import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { OrderPhoneModule } from '../src/order-phone/order-phone.module.js';
import { AuthService, SID } from '../src/auth/auth.service.js';

describe.skipIf(!process.env.DATABASE_URL)('Order phone HTTP PostgreSQL', () => {
  const schema = 'order_phone_test_' + randomUUID().replaceAll('-', '');
  const connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let db: PrismaClient;
  let app: NestExpressApplication;
  let created = false;
  let ownerId: number;
  let otherId: number;
  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let telegramId: number;

  async function session(userId: number) {
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return `${SID}=${token}`;
  }

  const api = (cookie: string) => request(app.getHttpServer()).get('/api/order-phones').set('Cookie', cookie);
  const add = (cookie: string, value: string) => request(app.getHttpServer())
    .post('/api/order-phones').set('Cookie', cookie).send({ phone: value });

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error('Local test database required');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    await connection.connect();
    if (!/^order_phone_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true }))
      .filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      await connection.query(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    }
    db = new PrismaClient({ adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL, options: '-c search_path=' + schema,
    }, { schema }) });
    const module = await Test.createTestingModule({ imports: [OrderPhoneModule] })
      .overrideProvider(DbService).useValue(db).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();

    const owner = await db.user.create({
      data: { role: 'USER', phone: '+79990000001', name: 'Owner' },
    });
    ownerId = owner.id;
    const other = await db.user.create({ data: { role: 'USER', phone: '+79990000003' } });
    otherId = other.id;
    const admin = await db.user.create({ data: { role: 'ADMIN', phone: '+79990000004' } });
    const identity = await db.telegramIdentity.create({
      data: { telegramUserId: BigInt(987654321), userId: ownerId,
        phoneNumber: '+79990000002', phoneVerified: true },
    });
    telegramId = identity.id;
    ownerCookie = await session(ownerId);
    otherCookie = await session(otherId);
    adminCookie = await session(admin.id);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (created) {
      await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await connection.end();
    vi.unstubAllEnvs();
  });

  it('lists sources and keeps manual phones separate from account and Telegram auth fields', async () => {
    const first = await api(ownerCookie).expect(200);
    expect(first.body).toMatchObject({
      primaryPhone: '+79990000001',
      phones: [
        { phone: '+79990000001', source: 'ACCOUNT' },
        { phone: '+79990000002', source: 'TELEGRAM' },
      ],
    });
    await add(ownerCookie, '8 (999) 000-00-01').expect(409);
    await add(ownerCookie, '+7 999 000 00 02').expect(409);
    const added = await add(ownerCookie, '8 (999) 000-00-05').expect(201);
    const manual = added.body.phones.find((item: { source: string }) => item.source === 'MANUAL');
    expect(manual.phone).toBe('+79990000005');
    await add(ownerCookie, '+79990000005').expect(409);
    const primary = await request(app.getHttpServer())
      .patch('/api/order-phones/primary').set('Cookie', ownerCookie)
      .send({ phone: '+79990000005' }).expect(200);
    expect(primary.body.primaryPhone).toBe('+79990000005');
    const edited = await request(app.getHttpServer())
      .patch(`/api/order-phones/${manual.id}`).set('Cookie', ownerCookie)
      .send({ phone: '8 999 000 00 06' }).expect(200);
    expect(edited.body.primaryPhone).toBe('+79990000006');
    const removed = await request(app.getHttpServer())
      .delete(`/api/order-phones/${manual.id}`).set('Cookie', ownerCookie).expect(200);
    expect(removed.body.primaryPhone).toBe('+79990000001');
    expect(await db.user.findUniqueOrThrow({ where: { id: ownerId },
      select: { phone: true, verifiedAt: true } })).toEqual({
      phone: '+79990000001', verifiedAt: null,
    });
    expect(await db.telegramIdentity.findUniqueOrThrow({ where: { id: telegramId },
      select: { phoneNumber: true, phoneVerified: true } })).toEqual({
      phoneNumber: '+79990000002', phoneVerified: true,
    });
    expect(await db.user.findUnique({ where: { phone: '+79990000006' } })).toBeNull();
  });

  it('enforces five manual phones under concurrency and isolates every owner route', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) => add(ownerCookie, `+7999111000${index}`)),
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(5);
    expect(attempts.filter((response) => response.status === 400)).toHaveLength(1);
    const listed = await api(ownerCookie).expect(200);
    const manual = listed.body.phones.filter((item: { source: string }) => item.source === 'MANUAL');
    expect(manual).toHaveLength(5);
    const id = manual[0].id;
    await request(app.getHttpServer()).patch(`/api/order-phones/${id}`)
      .set('Cookie', otherCookie).send({ phone: '+79992220000' }).expect(404);
    await request(app.getHttpServer()).delete(`/api/order-phones/${id}`)
      .set('Cookie', otherCookie).expect(404);
    await request(app.getHttpServer()).patch('/api/order-phones/primary')
      .set('Cookie', otherCookie).send({ phone: manual[0].phone }).expect(400);
    expect((await api(otherCookie).expect(200)).body.phones).toHaveLength(1);
    await api(adminCookie).expect(401);
    await request(app.getHttpServer()).get('/api/order-phones').expect(401);
    await add(adminCookie, '+79992220001').expect(401);

    // A trusted Telegram phone may arrive after a number was manually saved.
    await db.telegramIdentity.update({
      where: { id: telegramId },
      data: { phoneNumber: manual[0].phone },
    });
    const overlap = (await api(ownerCookie).expect(200)).body;
    expect(overlap.phones.filter((item: { phone: string }) => item.phone === manual[0].phone))
      .toHaveLength(1);
    expect(overlap.phones.find((item: { phone: string }) => item.phone === manual[0].phone))
      .toMatchObject({ source: 'TELEGRAM', manualId: id });
    expect(overlap.manualCount).toBe(5);
    await request(app.getHttpServer()).patch('/api/order-phones/primary')
      .set('Cookie', ownerCookie).send({ phone: manual[0].phone }).expect(200);
    const withoutManual = await request(app.getHttpServer())
      .delete(`/api/order-phones/${id}`).set('Cookie', ownerCookie).expect(200);
    expect(withoutManual.body.primaryPhone).toBe(manual[0].phone);
    expect(withoutManual.body.manualCount).toBe(4);

    vi.stubEnv('TEST_PHONE_AUTH_ENABLED', 'true');
    const login = await app.get(AuthService).testPhoneLogin(manual[1].phone);
    expect(login.user.id).not.toBe(ownerId);
    expect(login.user.phone).toBe(manual[1].phone);
    expect(await db.orderPhone.findFirst({
      where: { userId: ownerId, phone: manual[1].phone },
    })).not.toBeNull();
  });
});

