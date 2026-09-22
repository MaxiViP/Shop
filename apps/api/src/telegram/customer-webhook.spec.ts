import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CustomerTelegramController } from './customer.controller.js';
import { CustomerWebhookGuard } from './customer-webhook.guard.js';
import { CustomerUpdateService } from './customer-update.service.js';
import { TelegramController } from './telegram.controller.js';
import { TelegramWebhookGuard } from './telegram-webhook.guard.js';
import { TelegramUpdateService } from './telegram-update.service.js';

describe('separate Telegram webhook boundaries', () => {
  let app: INestApplication;
  const customerHandle = vi.fn().mockResolvedValue(undefined);
  const staffHandle = vi.fn().mockResolvedValue(undefined);
  let customerSecret: string;
  let staffSecret: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CustomerTelegramController, TelegramController],
      providers: [
        CustomerWebhookGuard, TelegramWebhookGuard,
        { provide: CustomerUpdateService, useValue: { handle: customerHandle } },
        { provide: TelegramUpdateService, useValue: { handle: staffHandle } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  beforeEach(() => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', randomUUID());
    vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    staffSecret = randomUUID();
    customerSecret = randomUUID();
    vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', staffSecret);
    vi.stubEnv('TELEGRAM_CUSTOMER_WEBHOOK_SECRET', customerSecret);
    customerHandle.mockClear();
    staffHandle.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => app.close());

  const post = (app: INestApplication, path: string, secret?: string) => {
    const req = request(app.getHttpServer()).post('/api/telegram/' + path + '/webhook');
    return secret ? req.set('X-Telegram-Bot-Api-Secret-Token', secret).send({ message: {} }) :
      req.send({ message: {} });
  };

  it('accepts each own secret but rejects missing/cross-bot/wrong secrets', async () => {
    await post(app, 'customer', customerSecret).expect(200);
    await post(app, 'staff', staffSecret).expect(404); // staff stays at the legacy /telegram/webhook
    await request(app.getHttpServer()).post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', staffSecret).send({ callback_query: {} }).expect(200);
    expect(customerHandle).toHaveBeenCalledTimes(1);
    expect(staffHandle).toHaveBeenCalledTimes(1);
    for (const secret of [undefined, staffSecret, 'wrong']) {
      await post(app, 'customer', secret).expect(403);
    }
    await request(app.getHttpServer()).post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', customerSecret).send({}).expect(403);
    expect(customerHandle).toHaveBeenCalledTimes(1);
    expect(staffHandle).toHaveBeenCalledTimes(1);
  });

  it('fails closed in legacy same-token mode and with same secrets', async () => {
    vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', '');
    await post(app, 'customer', customerSecret).expect(403);
    vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
    vi.stubEnv('TELEGRAM_CUSTOMER_WEBHOOK_SECRET', staffSecret);
    await post(app, 'customer', staffSecret).expect(403);
    expect(customerHandle).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', staffSecret).send({}).expect(200);
  });

  it('keeps old staff env as fallback', async () => {
    vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', '');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', staffSecret);
    await request(app.getHttpServer()).post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', staffSecret).send({}).expect(200);
    await post(app, 'customer', customerSecret).expect(403);
  });
});
