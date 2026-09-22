import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TelegramController } from './telegram.controller.js';
import { TelegramWebhookGuard } from './telegram-webhook.guard.js';
import { TelegramUpdateService } from './telegram-update.service.js';

describe('Telegram webhook HTTP boundary', () => {
  let app: INestApplication;
  let secret: string;
  const handle = vi.fn().mockResolvedValue(undefined);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TelegramController],
      providers: [TelegramWebhookGuard, { provide: TelegramUpdateService, useValue: { handle } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  beforeEach(() => {
    secret = randomUUID();
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', secret);
    vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', '');
    handle.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await app.close(); });

  it('accepts a valid secret and returns HTTP 200, including ignored update kinds', async () => {
    const body = { update_id: 1, message: { text: 'ignored' } };
    const response = await request(app.getHttpServer()).post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', secret).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledWith(body);
  });

  it.each(['missing-env', 'missing-header', 'wrong-header', 'short-header'])('rejects %s without handler execution or secret leakage', async kind => {
    if (kind === 'missing-env') vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    const call = request(app.getHttpServer()).post('/api/telegram/webhook');
    if (kind !== 'missing-header') call.set('X-Telegram-Bot-Api-Secret-Token',
      kind === 'wrong-header' ? randomUUID() : kind === 'short-header' ? 'x' : secret);
    const response = await call.send({ callback_query: { data: 'order:154:confirm' } });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(secret);
    expect(handle).not.toHaveBeenCalled();
  });
});
