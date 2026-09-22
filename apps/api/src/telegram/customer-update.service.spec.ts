import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import { CustomerUpdateService } from './customer-update.service.js';

const telegramId = 12345;
const publicId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const order = { publicId, status: 'NEW', total: 12345, finalTotal: null, createdAt: new Date('2026-09-22T09:00:00Z') };
const message = (text: string, id = telegramId, type = 'private') => ({
  message: { text, from: { id, is_bot: false }, chat: { id, type } },
});
const callback = (data: string, id = telegramId, type = 'private') => ({
  callback_query: {
    id: 'ack', data, from: { id, is_bot: false }, message: { chat: { id, type } },
  },
});
const fetcher = vi.fn<typeof fetch>();
function setup(linked = true) {
  const db = {
    telegramIdentity: {
      findUnique: vi.fn().mockResolvedValue(linked ? {
        userId: 7, firstName: 'Maksim', user: { name: 'Maksim' },
      } : null),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([order]),
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        where.publicId === foreignId ? null : order),
    },
  };
  const service = new CustomerUpdateService(db as unknown as DbService);
  return { db, service };
}
const sent = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', '');
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  fetcher.mockReset().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('customer Telegram updates', () => {
  it('/start activates a linked identity and shows private menu', async () => {
    const { db, service } = setup();
    await service.handle(message('/start'));
    expect(db.telegramIdentity.findUnique).toHaveBeenCalledWith({
      where: { telegramUserId: BigInt(telegramId) },
      select: { userId: true, firstName: true, user: { select: { name: true } } },
    });
    expect(db.telegramIdentity.update).toHaveBeenCalledWith({
      where: { telegramUserId: BigInt(telegramId) },
      data: { customerBotStartedAt: expect.any(Date), customerBotBlockedAt: null },
    });
    expect(sent()[0].text).toContain('Привет, Maksim!');
    expect(sent()[0].reply_markup.inline_keyboard).toMatchObject([
      [{ callback_data: 'orders' }], [{ callback_data: 'current' }],
      [{ url: 'https://shop.example/profile' }, { url: 'https://shop.example/' }],
    ]);
  });

  it('/start for unlinked user explains website login without creating user', async () => {
    const { db, service } = setup(false);
    await service.handle(message('/start'));
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(sent()[0].text).toContain('войдите через Telegram');
    expect(sent()[0].reply_markup.inline_keyboard[0][0].url).toBe('https://shop.example/');
  });

  it('/orders selects only linked user orders and uses public URLs', async () => {
    const { db, service } = setup();
    await service.handle(message('/orders'));
    expect(db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7 }, take: 5,
    }));
    expect(sent()[0].text).toContain('123,45');
    expect(sent()[0].reply_markup.inline_keyboard[0][0].callback_data).toBe('order:' + publicId);
    expect(sent()[0].reply_markup.inline_keyboard[0][1].url).toBe('https://shop.example/order/' + publicId);
    await service.handle(callback('order:' + publicId));
    expect(db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7, publicId },
    }));
    expect(sent().some(body => body.reply_markup?.inline_keyboard?.some(
      (row: Array<{ url?: string }>) => row.some(button => button.url === 'https://shop.example/order/' + publicId),
    ))).toBe(true);
  });

  it('current-order callback filters by owner and active statuses', async () => {
    const { db, service } = setup();
    await service.handle(callback('current'));
    expect(db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7, status: { in: ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'] } },
    }));
    expect(sent().at(-1)).toEqual({ callback_query_id: 'ack', text: 'Готово', cache_time: 0 });
  });

  it('denies a forged foreign order callback without revealing its data', async () => {
    const { db, service } = setup();
    await service.handle(callback('order:' + foreignId));
    expect(db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7, publicId: foreignId },
    }));
    expect(sent()).toEqual([{ callback_query_id: 'ack', text: 'Заказ недоступен', cache_time: 0 }]);
  });

  it('private-chat restriction prevents group and mismatched sender access', async () => {
    const { db, service } = setup();
    await service.handle(message('/orders', telegramId, 'group'));
    await service.handle({ message: { ...message('/orders').message, chat: { id: 999, type: 'private' } } });
    await service.handle(callback('orders', telegramId, 'supergroup'));
    expect(db.telegramIdentity.findUnique).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('invalid callbacks are ACKed and provider failures log no private data', async () => {
    const { service } = setup();
    await service.handle(callback('order:garbage'));
    expect(sent()).toEqual([{ callback_query_id: 'ack', text: 'Некорректная кнопка', cache_time: 0 }]);
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    fetcher.mockReset().mockRejectedValue(new Error('private provider body ' + publicId + token));
    await service.handle(message('/menu'));
    const logs = JSON.stringify([
      ...vi.mocked(Logger.prototype.warn).mock.calls,
      ...vi.mocked(Logger.prototype.error).mock.calls,
    ]);
    expect(logs).not.toContain(publicId);
    expect(logs).not.toContain(String(telegramId));
    expect(logs).not.toContain('private provider body');
    expect(logs).not.toContain(token);
  });
});
