import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { AuthCtrl } from '../src/auth/auth.ctrl.js';
import { AuthService } from '../src/auth/auth.service.js';
import { MethodGuard } from '../src/auth/method.guard.js';
import type { DbService } from '../src/db/db.service.js';

describe('Auth method HTTP', () => {
  let app: INestApplication<Server>;
  beforeEach(async () => {
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    vi.stubEnv('ADMIN_PASSWORD', randomBytes(32).toString('hex'));
    const module = await Test.createTestingModule({
      controllers: [AuthCtrl],
      providers: [
        MethodGuard,
        { provide: AuthService, useValue: new AuthService({} as DbService) },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('ordinary phone returns only OTP without DB lookup', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/method')
      .send({ phone: '+79990000002' })
      .expect(201)
      .expect({ method: 'OTP' });
  });
  it('normalizes configured phone and returns only PASSWORD', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/method')
      .send({ phone: '8 (999) 000-00-01' })
      .expect(201)
      .expect({ method: 'PASSWORD' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toContain(process.env.ADMIN_PHONE);
    expect(response.text).not.toContain(process.env.ADMIN_PASSWORD);
    expect(response.text).not.toContain('role');
  });
  it.each(['', '123', '+19990000001', 'bad'])(
    'invalid phone %s is rejected',
    async (phone) => {
      await request(app.getHttpServer())
        .post('/api/auth/method')
        .send({ phone })
        .expect(400);
    },
  );
  it('rejects unexpected payload fields', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/method')
      .send({ phone: '+79990000002', role: 'ADMIN' })
      .expect(400);
  });
  it('rate limit cannot be bypassed by spoofed X-Forwarded-For', async () => {
    for (let i = 0; i < 15; i++)
      await request(app.getHttpServer())
        .post('/api/auth/method')
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ phone: '+79990000002' })
        .expect(201);
    await request(app.getHttpServer())
      .post('/api/auth/method')
      .set('X-Forwarded-For', '10.1.2.3')
      .send({ phone: '+79990000002' })
      .expect(429);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
    try {
      await request(app.getHttpServer())
        .post('/api/auth/method')
        .send({ phone: '+79990000002' })
        .expect(201);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
