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
    it('does not link a different existing session by identity/name', async () => {
      const first = await post('telegram/mini-app', { initData: raw() }).expect(
        201,
      );
      const count = await db.user.count();
      await post('telegram/mini-app', { initData: raw() }, sid(first)).expect(
        409,
      );
      expect(await db.user.count()).toBe(count);
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
