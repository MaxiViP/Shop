import 'dotenv/config';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TelegramAuthService } from '../src/auth/telegram-auth.service.js';
import { TelegramOidcService } from '../src/auth/telegram-oidc.service.js';
import { OrderService } from '../src/order/order.service.js';
import { CoordinationService } from '../src/order/coordination.service.js';
import type { NotificationService } from '../src/order/notification.service.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import { customerView } from '../src/telegram/customer-callback.js';
import { CustomerUpdateService } from '../src/telegram/customer-update.service.js';
import { configureProxy } from '../src/auth/proxy.js';
import { guestTokenHash } from '../src/common/guest.js';
import { signedInitData } from './telegram.fixture.js';

// Destructive cleanup is limited to this random test schema, never public.
describe.skipIf(!process.env.DATABASE_URL)(
  'Telegram auth / isolated PostgreSQL',
  () => {
    const schema = 'telegram_auth_test_' + randomUUID().replaceAll('-', '');
    const connection = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    const secret = randomBytes(32).toString('hex');
    const botToken = randomBytes(32).toString('hex');
    let created = false;
    let db: PrismaClient;
    let app: NestExpressApplication;
    let auth: AuthService;
    let telegram: TelegramAuthService;
    let oidc: TelegramOidcService;
    let ip = 0;
    let existingUser = 0;
    let existingOrder = 0;
    let preservedOrder = 0;
    let preservedIdentity = 0;
    let id = 2000;
    const origin = 'http://localhost:3000';
    const raw = (userId = ++id, fields: Record<string, unknown> = {}) =>
      signedInitData(
        botToken,
        { id: userId, first_name: 'Test', username: 'old', ...fields },
        { query_id: randomUUID() },
      );
    const post = (path: string, body: unknown, cookie?: string) => {
      const value = request(app.getHttpServer())
        .post('/api/auth/' + path)
        .set('Origin', origin)
        .set('X-Forwarded-For', '198.51.100.' + ++ip)
        .send(body);
      return cookie ? value.set('Cookie', cookie) : value;
    };
    const sid = (response: { headers: Record<string, unknown> }) => {
      const values = response.headers['set-cookie'];
      if (!Array.isArray(values)) throw new Error('Missing session cookie');
      return String(
        values.find((value) => String(value).startsWith('sid=')),
      ).split(';')[0]!;
    };
    async function otp(phone: string) {
      await db.otp.upsert({
        where: { phone },
        create: {
          phone,
          codeHash: createHmac('sha256', secret)
            .update(phone + ':123456')
            .digest('hex'),
          expiresAt: new Date(Date.now() + 300_000),
        },
        update: {
          codeHash: createHmac('sha256', secret)
            .update(phone + ':123456')
            .digest('hex'),
          expiresAt: new Date(Date.now() + 300_000),
          attempts: 0,
        },
      });
    }
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Local test database required');
      vi.stubEnv('AUTH_SECRET', secret);
      vi.stubEnv('TELEGRAM_BOT_TOKEN', botToken);
      vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', '');
      vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', '');
      vi.stubEnv('TELEGRAM_CUSTOMER_WEBHOOK_SECRET', '');
      vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', '');
      vi.stubEnv('ADMIN_PHONE', '+79990000001');
      vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', '1001');
      vi.stubEnv('TRUST_PROXY', '127.0.0.1/32,::1/128');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Unexpected external request')),
      );
      await connection.connect();
      if (!/^telegram_auth_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe schema');
      await connection.query('CREATE SCHEMA "' + schema + '"');
      created = true;
      await connection.query('SET search_path TO "' + schema + '"');
      const root = resolve('prisma/migrations');
      for (const entry of (await readdir(root, { withFileTypes: true }))
        .filter((item) => item.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '20260921120000_telegram_identity') {
          const user = await connection.query<{ id: number }>(
            'INSERT INTO "User" (phone, "updatedAt") VALUES ($1, NOW()) RETURNING id',
            ['+79919999999'],
          );
          existingUser = user.rows[0]!.id;
          const order = await connection.query<{ id: number }>(
            `INSERT INTO "Order" ("type","customerName","customerPhone","subtotal","total","userId","updatedAt")
             VALUES ('PICKUP','preserved',$1,100,100,$2,NOW()) RETURNING id`,
            ['+79919999999', existingUser],
          );
          preservedOrder = order.rows[0]!.id;
          await connection.query(
            'INSERT INTO "Session" (id, "tokenHash", "expiresAt", "userId") VALUES ($1,$2,NOW()+INTERVAL \'1 day\',$3)',
            ['preserved-session', 'preserved-hash', existingUser],
          );
        }
        if (entry.name === '20260922190000_telegram_profile_metadata') {
          const identity = await connection.query<{ id: number }>(
            'INSERT INTO "TelegramIdentity" ("telegramUserId", "userId", username, "updatedAt") VALUES ($1,$2,$3,NOW()) RETURNING id',
            ['999000', existingUser, 'preserved'],
          );
          preservedIdentity = identity.rows[0]!.id;
        }
        await connection.query(
          await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
        );
      }
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: process.env.DATABASE_URL,
            options: '-c search_path=' + schema,
          },
          { schema },
        ),
      });
      const module = await Test.createTestingModule({ imports: [AuthModule] })
        .overrideProvider(DbService)
        .useValue(db)
        .compile();
      app = module.createNestApplication<NestExpressApplication>({
        logger: false,
      });
      configureProxy(app);
      app.use(cookieParser());
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
      await app.init();
      auth = module.get(AuthService);
      telegram = module.get(TelegramAuthService);
      oidc = module.get(TelegramOidcService);
    }, 30000);
    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
      if (created && /^telegram_auth_test_[a-f0-9]{32}$/.test(schema))
        await connection.query('DROP SCHEMA "' + schema + '" CASCADE');
      await connection.end();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }, 30000);

    it('separate CUSTOMER token validates Mini App proof without changing identity semantics', async () => {
      const customerToken = randomBytes(32).toString('hex');
      vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', customerToken);
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
      try {
        const config = await request(app.getHttpServer()).get('/api/auth/telegram/config').expect(200);
        expect(config.body.miniAppAvailable).toBe(true);
        const telegramId = ++id;
        const proof = signedInitData(customerToken, { id: telegramId, first_name: 'Customer' },
          { query_id: randomUUID() });
        const login = await telegram.miniApp(proof);
        expect(login.user).toMatchObject({ role: 'USER', phone: null });
        expect(await db.telegramIdentity.findUnique({
          where: { telegramUserId: BigInt(telegramId) },
        })).toMatchObject({ userId: login.user.id });
      } finally {
        vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', '');
        vi.stubEnv('TELEGRAM_BOT_TOKEN', botToken);
      }
    });

    it('migration preserves existing phone/user/session and allows multiple null phones', async () => {
      expect(
        await db.user.findUnique({ where: { id: existingUser } }),
      ).toMatchObject({ phone: '+79919999999', role: 'USER' });
      expect(
        await db.session.findUnique({ where: { id: 'preserved-session' } }),
      ).toMatchObject({ userId: existingUser, tokenHash: 'preserved-hash' });
      const users = await Promise.all([
        db.user.create({ data: {} }),
        db.user.create({ data: {} }),
      ]);
      expect(users.map((user) => user.phone)).toEqual([null, null]);
    });
    it('migration preserves existing order ownership, status and amounts', async () => {
      expect(
        await db.order.findUnique({ where: { id: preservedOrder } }),
      ).toMatchObject({
        userId: existingUser,
        status: 'NEW',
        subtotal: 100,
        total: 100,
        customerPhone: '+79919999999',
      });
    });
    it('metadata migration preserves existing Telegram identity with nullable/default fields', async () => {
      expect(await db.telegramIdentity.findUniqueOrThrow({ where: { id: preservedIdentity } }))
        .toMatchObject({ telegramUserId: 999000n, userId: existingUser, username: 'preserved', photoUrl: null, phoneNumber: null, phoneVerified: false });
    });
    it('customer bot activation and order reads stay bound to the linked User in PostgreSQL', async () => {
      const foreignUser = await db.user.create({ data: {} });
      const owned = await db.order.create({ data: {
        type: 'PICKUP', customerName: 'Owned', customerPhone: '+79911111111',
        subtotal: 12345, total: 12345, userId: existingUser,
      } });
      const foreign = await db.order.create({ data: {
        type: 'PICKUP', customerName: 'Foreign', customerPhone: '+79912222222',
        subtotal: 77777, total: 77777, userId: foreignUser.id,
      } });
      const previousFetch = globalThis.fetch;
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(String(init.body));
        return Response.json({ ok: true, result: { message_id: calls.length } });
      }));
      try {
        const typed = db as unknown as DbService;
        const domainOrders = new OrderService(typed, { notifyNewOrder: async () => {} } as unknown as TelegramService);
        const coordination = new CoordinationService(typed, domainOrders, { dispatch: async () => {} } as unknown as NotificationService);
        const bot = new CustomerUpdateService(typed, coordination, domainOrders);
        const actor = { id: 999000, is_bot: false };
        const chat = { id: 999000, type: 'private' };
        await bot.handle({ message: { message_id: 1, from: actor, chat, text: '/start' } });
        expect(await db.telegramIdentity.findUniqueOrThrow({ where: { id: preservedIdentity } }))
          .toMatchObject({ customerBotStartedAt: expect.any(Date), customerBotBlockedAt: null });
        await bot.handle({ message: { message_id: 2, from: actor, chat, text: '/orders' } });
        expect(calls.join(' ')).toContain(customerView('o', owned.publicId));
        expect(calls.join(' ')).not.toContain(customerView('o', foreign.publicId));
        const before = calls.length;
        await bot.handle({ callback_query: {
          id: 'foreign', from: actor, message: { message_id: 3, chat }, data: 'order:' + foreign.publicId,
        } });
        expect(calls.slice(before)).toHaveLength(1);
        expect(calls[before]).toContain('Заказ недоступен');
      } finally {
        vi.stubGlobal('fetch', previousFetch);
      }
    });
    it('persists verified OIDC metadata without linking User.phone and preserves it across Mini App login', async () => {
      const telegramId = ++id;
      const first = await telegram.login({
        profile: { id: telegramId, first_name: 'Initial', photo_url: 'https://example.test/first.webp' },
        phone: { number: '+79991234567', verified: true },
        tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 300_000),
      });
      expect(first.user.phone).toBeNull();
      expect(first.user.telegram).toMatchObject({ connected: true, phoneNumber: '+79991234567', phoneVerified: true, photoUrl: 'https://example.test/first.webp' });
      await db.user.update({ where: { id: first.user.id }, data: { name: 'User chosen name' } });
      const again = await telegram.miniApp(raw(telegramId));
      expect(again.user.id).toBe(first.user.id);
      expect(again.user.name).toBe('User chosen name');
      expect(again.user.phone).toBeNull();
      expect(again.user.telegram).toMatchObject({ phoneNumber: '+79991234567', phoneVerified: true, photoUrl: 'https://example.test/first.webp' });
      const me = await request(app.getHttpServer()).get('/api/auth/me')
        .set('Cookie', 'sid=' + again.token).expect(200);
      expect(me.headers['cache-control']).toBe('no-store');
      expect(me.body.telegram).toEqual({
        connected: true, username: 'old', firstName: 'Test', lastName: null,
        photoUrl: 'https://example.test/first.webp', phoneNumber: '+79991234567', phoneVerified: true,
      });
      expect(Object.keys(me.body).sort()).toEqual(['id', 'name', 'phone', 'role', 'telegram', 'verifiedAt']);
      expect(JSON.stringify(me.body)).not.toMatch(/telegramUserId|telegramIdentity|tokenHash/);
      expect(me.body.telegram).not.toHaveProperty('id');
      const updated = await telegram.miniApp(raw(telegramId, { photo_url: 'https://example.test/new.webp' }));
      expect(updated.user.telegram).toMatchObject({ photoUrl: 'https://example.test/new.webp', phoneNumber: '+79991234567', phoneVerified: true });
      expect(await db.telegramIdentity.count({ where: { telegramUserId: BigInt(telegramId) } })).toBe(1);
    });
    it('does not carry verified=true over to a different unverified Telegram phone', async () => {
      const telegramId = ++id;
      const base = { profile: { id: telegramId }, expiresAt: new Date(Date.now() + 300_000) };
      await telegram.login({ ...base, tokenHash: randomUUID(), phone: { number: '+79991234567', verified: true } });
      const next = await telegram.login({ ...base, tokenHash: randomUUID(), phone: { number: '+79997654321', verified: false } });
      expect(next.user.telegram).toMatchObject({ phoneNumber: '+79997654321', phoneVerified: false });
      expect(next.user.phone).toBeNull();
    });
    it('/auth/me keeps a normal phone account compatible with telegram=null', async () => {
      const user = await db.user.create({ data: { phone: '+79918888888' } });
      const token = await auth.createSession(db, user.id);
      const me = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', 'sid=' + token).expect(200);
      expect(me.body).toMatchObject({ id: user.id, phone: '+79918888888', telegram: null });
    });
    it('verified Mini App switches a different USER or ADMIN SID without merging accounts', async () => {
      const former = await db.user.create({ data: { role: 'USER', name: 'Former' } });
      const formerToken = await auth.createSession(db, former.id);
      const telegramId = ++id;
      const first = await post('telegram/mini-app', { initData: raw(telegramId) }, 'sid=' + formerToken).expect(201);
      expect(first.body).toMatchObject({ role: 'USER', phone: null });
      expect(first.body.id).not.toBe(former.id);
      expect(await auth.me(formerToken)).toBeNull();
      expect((await auth.me(sid(first).slice(4)))?.id).toBe(first.body.id);
      expect(await db.user.findUnique({ where: { id: former.id } })).toMatchObject({ role: 'USER', name: 'Former' });
      expect(await db.telegramIdentity.findUnique({ where: { telegramUserId: BigInt(telegramId) } }))
        .toMatchObject({ userId: first.body.id });

      const admin = await db.user.upsert({ where: { phone: '+79990000001' },
        create: { role: 'ADMIN', phone: '+79990000001' }, update: { role: 'ADMIN' } });
      const same = await post('telegram/mini-app', { initData: raw(telegramId) }, sid(first)).expect(201);
      expect(same.body.id).toBe(first.body.id);
      expect(await auth.me(sid(first).slice(4))).toBeNull();
      const adminToken = await auth.createSession(db, admin.id);
      await post('telegram/mini-app', { initData: 'user={"id":123}' }, 'sid=' + adminToken).expect(401);
      expect((await auth.me(adminToken))?.id).toBe(admin.id);
      const second = await post('telegram/mini-app', { initData: raw(telegramId) }, 'sid=' + adminToken).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(await auth.me(adminToken)).toBeNull();
      expect((await auth.me(sid(second).slice(4)))?.id).toBe(first.body.id);
      expect(await db.user.findUnique({ where: { id: admin.id } })).toMatchObject({ role: 'ADMIN' });
      expect(await db.telegramIdentity.count({ where: { telegramUserId: BigInt(telegramId) } })).toBe(1);
      await db.user.delete({ where: { id: admin.id } });
    });
    it('normal OIDC identity login still requires explicit linking for another SID', async () => {
      const telegramId = ++id;
      const linked = await telegram.miniApp(raw(telegramId));
      const other = await db.user.create({ data: { role: 'USER' } });
      const token = await auth.createSession(db, other.id);
      await expect(telegram.login({ profile: { id: telegramId }, tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 300_000) }, token)).rejects.toThrow('ACCOUNT_LINK_REQUIRED');
      expect((await auth.me(token))?.id).toBe(other.id);
      expect(await db.telegramIdentity.findUnique({ where: { telegramUserId: BigInt(telegramId) } }))
        .toMatchObject({ userId: linked.user.id });
    });
    it('serializes two free phone attachments to the same account', async () => {
      const user = await telegram.miniApp(raw());
      const before = await db.user.count();
      const phones = ['+79912220003', '+79912220004'];
      await Promise.all(phones.map((phone) => otp(phone)));
      const results = await Promise.allSettled(
        phones.map((phone) =>
          auth.login(phone, '123456', undefined, user.user.id),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.message).toBe(
        'ACCOUNT_LINK_REQUIRED',
      );
      expect(await db.user.count()).toBe(before);
      const saved = await db.user.findUniqueOrThrow({
        where: { id: user.user.id },
      });
      expect(phones).toContain(saved.phone);
      await otp(saved.phone!);
      expect(
        (await auth.login(saved.phone, '123456', undefined, user.user.id)).user
          .id,
      ).toBe(user.user.id);
    });

    it('creates USER + identity + normal HttpOnly session; me returns safe nullable DTO even for staff allowlist ID', async () => {
      const res = await post('telegram/mini-app', {
        initData: raw(1001),
      }).expect(201);
      expect(res.body).toMatchObject({
        role: 'USER',
        phone: null,
        verifiedAt: null,
        name: 'Test',
      });
      expect(res.body).not.toHaveProperty('token');
      expect(res.body).not.toHaveProperty('telegramUserId');
      const cookie = sid(res);
      expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
      expect(String(res.headers['set-cookie'])).toContain('SameSite=Lax');
      const token = cookie.slice(4);
      expect(
        await db.session.findUnique({
          where: {
            tokenHash: createHash('sha256').update(token).digest('hex'),
          },
        }),
      ).toMatchObject({ userId: res.body.id });
      expect(
        await db.telegramIdentity.findUnique({
          where: { telegramUserId: 1001n },
        }),
      ).toMatchObject({ userId: res.body.id });
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookie)
        .expect(200, res.body);
    });
    it('updates profile only; repeated fresh proofs resolve same account, rotate sessions and preserve custom name', async () => {
      const tg = ++id;
      const first = await post('telegram/mini-app', {
        initData: raw(tg),
      }).expect(201);
      await db.user.update({
        where: { id: first.body.id },
        data: { name: 'Custom' },
      });
      const next = await post(
        'telegram/mini-app',
        { initData: raw(tg, { username: 'new', first_name: 'Changed' }) },
        sid(first),
      ).expect(201);
      expect(next.body).toMatchObject({ id: first.body.id, name: 'Custom' });
      expect(await auth.me(sid(first).slice(4))).toBeNull();
      expect(
        await db.telegramIdentity.findUnique({
          where: { telegramUserId: BigInt(tg) },
        }),
      ).toMatchObject({ username: 'new', firstName: 'Changed' });
    });
    it('concurrent first logins cannot leave duplicate/orphan users', async () => {
      const tg = ++id;
      const before = await db.user.count();
      const results = await Promise.all([
        telegram.miniApp(raw(tg)),
        telegram.miniApp(raw(tg)),
      ]);
      expect(results[0]!.user.id).toBe(results[1]!.user.id);
      expect(await db.user.count()).toBe(before + 1);
      expect(
        await db.telegramIdentity.count({
          where: { telegramUserId: BigInt(tg) },
        }),
      ).toBe(1);
      await expect(
        db.telegramIdentity.create({
          data: { telegramUserId: BigInt(++id), userId: results[0]!.user.id },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
    it('consumes proofs atomically, rejects reordered replay, bounded cleanup removes expired rows', async () => {
      const initData = raw();
      const results = await Promise.allSettled([
        telegram.miniApp(initData),
        telegram.miniApp(initData),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const reordered = new URLSearchParams(
        [...new URLSearchParams(initData)].reverse(),
      ).toString();
      await expect(telegram.miniApp(reordered)).rejects.toThrow(
        'TELEGRAM_AUTH_REPLAY',
      );
      await db.telegramAuthReplay.create({
        data: { tokenHash: 'expired', expiresAt: new Date(0) },
      });
      await telegram.miniApp(raw());
      expect(
        await db.telegramAuthReplay.findUnique({
          where: { tokenHash: 'expired' },
        }),
      ).toBeNull();
    });
    it('rejects arbitrary ID, separate user, unsigned data and foreign/missing origins', async () => {
      await post('telegram/mini-app', { telegramUserId: 123 }).expect(400);
      await post('telegram/mini-app', {
        initData: raw(),
        user: { id: 123 },
      }).expect(400);
      await post('telegram/mini-app', { initData: 'user={"id":123}' }).expect(
        401,
      );
      await post('telegram/mini-app', { initData: raw() })
        .set('Origin', 'https://evil.example')
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/auth/telegram/mini-app')
        .send({ initData: raw() })
        .expect(403);
    });
    it('switches to another verified Telegram USER without linking by identity/name', async () => {
      const first = await post('telegram/mini-app', { initData: raw() }).expect(201);
      const oldToken = sid(first).slice(4);
      const count = await db.user.count();
      const next = await post('telegram/mini-app', { initData: raw() }, sid(first)).expect(201);
      expect(next.body.id).not.toBe(first.body.id);
      expect(await db.user.count()).toBe(count + 1);
      expect(await auth.me(oldToken)).toBeNull();
      expect((await auth.me(sid(next).slice(4)))?.id).toBe(next.body.id);
    });
    it('attaches a free OTP-verified phone to the SAME Telegram User', async () => {
      const first = await post('telegram/mini-app', { initData: raw() }).expect(
        201,
      );
      const count = await db.user.count();
      await otp('+79912220001');
      const result = await post(
        'login',
        { phone: '+79912220001', code: '123456' },
        sid(first),
      ).expect(201);
      expect(result.body).toMatchObject({
        id: first.body.id,
        phone: '+79912220001',
        role: 'USER',
      });
      expect(result.body.verifiedAt).not.toBeNull();
      expect(await db.user.count()).toBe(count);
    });
    it('occupied phone requires linking, preserves both accounts and rejects admin phone', async () => {
      const first = await post('telegram/mini-app', { initData: raw() }).expect(
        201,
      );
      await otp('+79919999999');
      const count = await db.user.count();
      const res = await post(
        'login',
        { phone: '+79919999999', code: '123456' },
        sid(first),
      ).expect(409);
      expect(res.body.message).toBe('ACCOUNT_LINK_REQUIRED');
      expect(await db.user.count()).toBe(count);
      expect(
        await db.user.findUnique({ where: { id: first.body.id } }),
      ).toMatchObject({ phone: null });
      await otp('+79990000001');
      await post(
        'login',
        { phone: '+79990000001', code: '123456' },
        sid(first),
      ).expect(401);
    });
    it('phone OTP guest attachment remains restricted to verified phone and guest token; Telegram alone does not claim it', async () => {
      const guestToken = randomBytes(32).toString('hex');
      const guest = await db.guestSession.create({
        data: {
          tokenHash: guestTokenHash(guestToken),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      const order = await db.order.create({
        data: {
          publicId: randomUUID(),
          type: 'PICKUP',
          customerName: 'Test',
          customerPhone: '+79912220002',
          subtotal: 100,
          total: 100,
          deliveryPrice: 0,
          guestSessionId: guest.id,
        },
      });
      existingOrder = order.id;
      await telegram.miniApp(raw());
      expect(
        await db.order.findUnique({ where: { id: order.id } }),
      ).toMatchObject({ userId: null });
      await otp('+79912220002');
      const result = await auth.login('+79912220002', '123456', guestToken);
      expect(
        await db.order.findUnique({ where: { id: order.id } }),
      ).toMatchObject({ userId: result.user.id });
    });
    it('null-phone ADMIN cannot use customer auth or pass me when admin config is missing', async () => {
      const tg = ++id;
      const result = await telegram.miniApp(raw(tg));
      await db.user.update({
        where: { id: result.user.id },
        data: { role: 'ADMIN' },
      });
      vi.stubEnv('ADMIN_PHONE', '');
      expect(await auth.me(result.token)).toBeNull();
      await expect(telegram.miniApp(raw(tg))).rejects.toThrow(
        'TELEGRAM_AUTH_INVALID',
      );
      vi.stubEnv('ADMIN_PHONE', '+79990000001');
    });
    it('configured admin phone cannot use Telegram even before ADMIN bootstrap', async () => {
      const tg = ++id;
      const result = await telegram.miniApp(raw(tg));
      await db.user.update({
        where: { id: result.user.id },
        data: { phone: '+79990000001' },
      });
      await expect(telegram.miniApp(raw(tg))).rejects.toThrow(
        'TELEGRAM_AUTH_INVALID',
      );
    });
    it('OIDC callback uses same identity/session and consumes state once; failure clears flow cookie', async () => {
      vi.stubEnv('TELEGRAM_OIDC_CLIENT_ID', 'test');
      vi.stubEnv(
        'TELEGRAM_OIDC_CLIENT_SECRET',
        randomBytes(32).toString('hex'),
      );
      vi.stubEnv(
        'TELEGRAM_OIDC_REDIRECT_URI',
        'https://shop.example/api/auth/telegram/callback',
      );
      vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
      const mini = await telegram.miniApp(raw(++id));
      const proof = {
        profile: { id },
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 300_000),
      };
      const verify = vi.spyOn(oidc, 'callback').mockResolvedValue(proof);
      const start = await post('telegram/start', {}).expect(201);
      expect(String(start.headers['set-cookie'])).toContain('HttpOnly');
      const result = await request(app.getHttpServer())
        .get('/api/auth/telegram/callback?code=test&state=test')
        .expect(303);
      expect(result.headers.location).toBe('https://shop.example/profile');
      expect((await auth.me(sid(result).slice(4)))?.id).toBe(mini.user.id);
      const replay = await request(app.getHttpServer())
        .get('/api/auth/telegram/callback?code=test&state=test')
        .expect(303);
      expect(replay.headers.location).toBe(
        'https://shop.example/telegram?error=login',
      );
      expect(String(replay.headers['set-cookie'])).toContain('telegram-flow=;');
      verify.mockRestore();
      expect(await db.order.count({ where: { id: existingOrder } })).toBe(1);
    });
  },
);
