import { Test } from '@nestjs/testing';
import {
  StandardSchemaValidationPipe,
  UnauthorizedException,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AuthCtrl } from '../src/auth/auth.ctrl.js';
import { AuthService } from '../src/auth/auth.service.js';
import { configureProxy } from '../src/auth/proxy.js';

describe('Auth HTTP behind a trusted reverse proxy', () => {
  let app: NestExpressApplication | undefined;
  const phone = '+79990000002';
  async function start(trust = '') {
    vi.stubEnv('TRUST_PROXY', trust);
    const module = await Test.createTestingModule({
      controllers: [AuthCtrl],
      providers: [
        {
          provide: AuthService,
          useValue: {
            method: () => ({ method: 'OTP' }),
            adminLogin: () => {
              throw new UnauthorizedException();
            },
            code: () => ({ ok: true }),
            login: () => {
              throw new UnauthorizedException();
            },
            me: () => null,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureProxy(app);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
  }
  const post = (path: string, ip?: string) => {
    const call = request(app!.getHttpServer()).post(`/api/auth/${path}`);
    if (ip) call.set('X-Forwarded-For', ip);
    return call.send(
      path === 'admin/login'
        ? { phone, password: 'wrong' }
        : path === 'login'
          ? { phone, code: '000000' }
          : { phone },
    );
  };
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('direct local development works with no forwarded headers', async () => {
    await start();
    await post('method').expect(201);
    await post('code').expect(201);
  });
  it.each(['', '10.20.30.1/32'])(
    'ignores spoofed XFF when socket is not trusted (%s)',
    async (trust) => {
      await start(trust);
      for (let i = 0; i < 15; i++)
        await post('method', `192.0.2.${i + 1}`).expect(201);
      await post('method', '198.51.100.1').expect(429);
    },
  );
  it.each([
    ['method', 15, 201],
    ['admin/login', 5, 401],
    ['code', 10, 201],
    ['login', 30, 401],
  ] as const)(
    '%s separates A/B but preserves same-client limits',
    async (path, count, status) => {
      await start('127.0.0.1/32,::1/128');
      for (let i = 0; i < count; i++)
        await post(path, '192.0.2.1').expect(status);
      await post(path, '192.0.2.1').expect(429);
      // Fake leftmost addresses do not bypass the nearest untrusted hop A.
      await post(path, '198.51.100.99, 192.0.2.1').expect(429);
      await post(path, '192.0.2.2').expect(status);
    },
  );
  it('IPv4 and both IPv4-mapped representations share a bucket', async () => {
    await start('127.0.0.1/32,::1/128');
    for (let i = 0; i < 5; i++)
      await post('admin/login', '192.0.2.1').expect(401);
    await post('admin/login', '::ffff:192.0.2.1').expect(429);
    await post('admin/login', '::ffff:c000:201').expect(429);
    await post('admin/login', '192.0.2.2').expect(401);
  });
  it('canonical IPv6 variants share a bucket and a different IPv6 client stays independent', async () => {
    await start('127.0.0.1/32,::1/128');
    for (let i = 0; i < 5; i++)
      await post('admin/login', '2001:db8::1').expect(401);
    await post('admin/login', '2001:0DB8:0:0:0:0:0:1').expect(429);
    await post('admin/login', '2001:db8::2').expect(401);
  });
  it('walks a configured multi-proxy chain only as far as the nearest untrusted hop', async () => {
    await start('127.0.0.1/32,::1/128,10.20.30.0/24');
    for (let i = 0; i < 5; i++)
      await post('admin/login', '192.0.2.1, 10.20.30.4').expect(401);
    await post('admin/login', '203.0.113.9, 192.0.2.1, 10.20.30.4').expect(429);
    await post('admin/login', '192.0.2.2, 10.20.30.4').expect(401);
  });
});
