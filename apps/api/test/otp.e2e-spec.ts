import 'dotenv/config';
import { randomBytes, randomInt, randomUUID, createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
import { configureProxy } from '../src/auth/proxy.js';

// PostgreSQL transactions and observable lock queues, not mocked race outcomes.
describe.skipIf(!process.env.DATABASE_URL)('OTP lifecycle / PostgreSQL', () => {
  const schema = `otp_test_${randomUUID().replaceAll('-', '')}`;
  const connection = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  const secret = randomBytes(32).toString('hex');
  let db: PrismaClient;
  let app: NestExpressApplication;
  let created = false;
  let sequence = randomInt(1000000, 8000000);
  let ipSequence = 0;
  const phone = () => `+7991${sequence++}`;
  const ip = () => `198.51.100.${++ipSequence}`;
  const hash = (number: string, code: string) =>
    createHmac('sha256', secret).update(`${number}:${code}`).digest('hex');
  const post = (
    path: 'code' | 'login',
    number: string,
    code?: string,
    client = ip(),
  ) =>
    request(app.getHttpServer())
      .post(`/api/auth/${path}`)
      .set('X-Forwarded-For', client)
      .send(path === 'code' ? { phone: number } : { phone: number, code });
  const sessions = (number: string) =>
    db.session.count({ where: { user: { phone: number } } });
  async function seed(
    number: string,
    code = '000000',
    attempts = 0,
    expired = false,
  ) {
    return db.otp.create({
      data: {
        phone: number,
        codeHash: hash(number, code),
        attempts,
        createdAt: new Date(Date.now() - 61_000),
        expiresAt: new Date(Date.now() + (expired ? -1 : 300_000)),
      },
    });
  }
  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function waiters(number: string, count: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await connection.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_locks
         WHERE locktype = 'advisory' AND classid = 704002 AND objsubid = 2
         AND objid = (hashtext($1)::bigint & 4294967295)::oid AND NOT granted`,
        [number],
      );
      if (result.rows[0]!.count === count) return;
      await delay(10);
    }
    throw new Error(
      'OTP requests did not reach the expected PostgreSQL lock queue',
    );
  }
  async function block(number: string) {
    const blocker = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(704002, hashtext($1))', [
      number,
    ]);
    return async () => {
      await blocker.query('COMMIT');
      await blocker.end();
    };
  }
  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', secret);
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    vi.stubEnv('TRUST_PROXY', '127.0.0.1/32,::1/128');
    await connection.connect();
    if (!/^otp_test_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unsafe test schema');
    await connection.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20260912150000_otp_identity') {
        await connection.query(
          `INSERT INTO "Otp" (phone, "codeHash", attempts, "expiresAt") VALUES ($1, $2, 2, NOW() + INTERVAL '5 minutes')`,
          ['+79919999999', hash('+79919999999', '123456')],
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
          options: `-c search_path=${schema}`,
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
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (created && /^otp_test_[a-f0-9]{32}$/.test(schema))
      await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection.end();
    vi.unstubAllEnvs();
  }, 30000);

  it('migration preserves an existing code and adds a generation identity', async () => {
    expect(
      await db.otp.findUniqueOrThrow({ where: { phone: '+79919999999' } }),
    ).toMatchObject({
      id: expect.any(String),
      attempts: 2,
      codeHash: hash('+79919999999', '123456'),
    });
    await post('login', '+79919999999', '123456').expect(201);
  });
  it('N-1 attempts plus two queued wrong logins allows exactly one comparison', async () => {
    const number = phone();
    await seed(number, '123456', 4);
    const release = await block(number);
    const first = post('login', number, '000000').then((value) => value);
    const second = post('login', number, '000000').then((value) => value);
    try {
      await waiters(number, 2);
    } finally {
      await release();
    }
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual([401, 429]);
    expect(results.find((result) => result.status === 429)!.body.message).toBe(
      'Слишком много попыток',
    );
    expect(
      (await db.otp.findUniqueOrThrow({ where: { phone: number } })).attempts,
    ).toBe(5);
    await post('login', number, '123456').expect(429);
    expect(await sessions(number)).toBe(0);
  });
  it('five wrong attempts persist even though HTTP returns 401; another IP cannot bypass the phone limit', async () => {
    const number = phone();
    await seed(number, '123456');
    for (let i = 0; i < 5; i++)
      await post('login', number, '000000').expect(401);
    await post('login', number, '000000').expect(429);
    expect(
      (await db.otp.findUniqueOrThrow({ where: { phone: number } })).attempts,
    ).toBe(5);
  });
  it.each([false, true])(
    'parallel code requests serialize even when a row exists=%s',
    async (existing) => {
      const number = phone();
      const old = existing ? await seed(number, '000000', 4) : null;
      const release = await block(number);
      const first = post('code', number).then((value) => value);
      const second = post('code', `8${number.slice(2)}`).then((value) => value);
      try {
        await waiters(number, 2);
      } finally {
        await release();
      }
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 429]);
      expect(
        results.find((result) => result.status === 429)!.body.message,
      ).toBe('Повторите запрос через минуту');
      const current = await db.otp.findUniqueOrThrow({
        where: { phone: number },
      });
      expect(current.id).not.toBe(old?.id);
      expect(current.attempts).toBe(0);
      expect(current.codeHash).toBe(
        hash(
          number,
          results.find((result) => result.status === 201)!.body
            .devCode as string,
        ),
      );
      expect(await db.otp.count({ where: { phone: number } })).toBe(1);
      await post('code', number).expect(429);
      expect(
        await db.otp.findUniqueOrThrow({ where: { phone: number } }),
      ).toEqual(current);
    },
  );
  it.each(['login', 'code'] as const)(
    'login old OTP vs resend: queued %s first preserves the new generation',
    async (firstAction) => {
      const number = phone();
      const old = await seed(number);
      const release = await block(number);
      const first = post(firstAction, number, '000000').then((value) => value);
      let second: Promise<request.Response> | undefined;
      try {
        await waiters(number, 1);
        second = post(
          firstAction === 'login' ? 'code' : 'login',
          number,
          '000000',
        ).then((value) => value);
        await waiters(number, 2);
      } finally {
        await release();
      }
      const a = await first,
        b = await second!;
      const login = firstAction === 'login' ? a : b;
      const resend = firstAction === 'code' ? a : b;
      expect(resend.status).toBe(201);
      expect(login.status).toBe(firstAction === 'login' ? 201 : 401);
      const current = await db.otp.findUniqueOrThrow({
        where: { phone: number },
      });
      expect(current.id).not.toBe(old.id);
      expect(current.codeHash).toBe(
        hash(number, resend.body.devCode as string),
      );
      await post('login', number, resend.body.devCode as string).expect(201);
    },
  );
  it('parallel correct logins create exactly one session and consume once', async () => {
    const number = phone();
    await seed(number, '123456');
    const release = await block(number);
    const first = post('login', number, '123456').then((value) => value);
    const second = post('login', number, '123456').then((value) => value);
    try {
      await waiters(number, 2);
    } finally {
      await release();
    }
    expect(
      (await Promise.all([first, second]))
        .map((result) => result.status)
        .sort(),
    ).toEqual([201, 401]);
    expect(await sessions(number)).toBe(1);
    expect(await db.otp.findUnique({ where: { phone: number } })).toBeNull();
    await post('login', number, '123456').expect(401);
  });
  it('expiry rejects login, and replacement resets attempts with a new identity', async () => {
    const number = phone();
    const old = await seed(number, '000000', 4, true);
    await post('login', number, '000000').expect(401);
    expect(
      await db.otp.findUniqueOrThrow({ where: { phone: number } }),
    ).toEqual(old);
    const fresh = await post('code', number).expect(201);
    const current = await db.otp.findUniqueOrThrow({
      where: { phone: number },
    });
    expect(current.id).not.toBe(old.id);
    expect(current.attempts).toBe(0);
    await post('login', number, fresh.body.devCode as string).expect(201);
  });
  it('consume checks the exact generation even if a writer bypasses the locking protocol', async () => {
    const number = phone();
    const old = await seed(number, '123456');
    const read = barrier(),
      resume = barrier();
    const extended = db.$extends({
      query: {
        otp: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (args.where.phone === number) {
              read.resolve();
              await resume.promise;
            }
            return row;
          },
        },
      },
    });
    const service = new AuthService(extended as unknown as DbService);
    const result = service.login(number, '123456').then(
      () => null,
      (error: unknown) => error,
    );
    await read.promise;
    const id = randomUUID();
    try {
      // Independent committed transaction replaces the already-read generation.
      await db.otp.update({
        where: { phone: number },
        data: { id, codeHash: hash(number, '654321'), attempts: 0 },
      });
    } finally {
      resume.resolve();
    }
    expect(await result).toMatchObject({ status: 401 });
    expect(id).not.toBe(old.id);
    expect(
      await db.otp.findUniqueOrThrow({ where: { phone: number } }),
    ).toMatchObject({ id, attempts: 0 });
    expect(await sessions(number)).toBe(0);
  });
  it('session-write failure rolls consumption back; retry can still use that OTP', async () => {
    const number = phone();
    const otp = await seed(number, '123456');
    await connection.query(
      `CREATE FUNCTION fail_otp_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic session failure'; END $$`,
    );
    await connection.query(
      `CREATE TRIGGER fail_otp_session BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION fail_otp_session()`,
    );
    try {
      await post('login', number, '123456').expect(500);
    } finally {
      await connection.query('DROP TRIGGER fail_otp_session ON "Session"');
      await connection.query('DROP FUNCTION fail_otp_session()');
    }
    expect(
      await db.otp.findUniqueOrThrow({ where: { phone: number } }),
    ).toEqual(otp);
    expect(await sessions(number)).toBe(0);
    await post('login', number, '123456').expect(201);
  });
  it('production still omits devCode; this change does not implement SMS delivery', async () => {
    const previous = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await post('code', phone()).expect(201).expect({ ok: true });
    } finally {
      vi.stubEnv('NODE_ENV', previous);
    }
  });
});
