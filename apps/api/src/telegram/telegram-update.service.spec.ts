import { randomUUID } from 'node:crypto';
import { BadRequestException, Logger } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { OrderStatus } from '../db/gen/client.js';
import { StaffService } from '../staff/staff.service.js';
import type { NotificationService } from '../order/notification.service.js';
import { TelegramService } from './telegram.service.js';
import { TelegramUpdateService } from './telegram-update.service.js';
import { orderKeyboard, parseAction, type OrderCallback } from './callback.js';

const callback = (data = 'order:154:confirm'): OrderCallback => ({
  id: 'query', from: { id: 123, is_bot: false }, data,
  message: { message_id: 77, date: 1700000000, chat: { id: 123, type: 'private' } },
});
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', '123,-100456');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', randomUUID());
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function setup(initial: OrderStatus = 'NEW') {
  let status = initial;
  const findUnique = vi.fn(async () => ({ status }));
  const db = { order: { findUnique } } as unknown as DbService;
  const staff = {
    confirm: vi.fn(async () => { status = 'CONFIRMED'; }),
    startAssembly: vi.fn(async () => { status = 'ASSEMBLING'; }),
    cancel: vi.fn(),
  };
  const telegram = new TelegramService(db);
  const answer = vi.spyOn(telegram, 'answerCallbackQuery');
  const edit = vi.spyOn(telegram, 'editOrderKeyboard');
  const handler = new TelegramUpdateService(db, staff as unknown as StaffService, telegram);
  return { db, findUnique, staff, telegram, answer, edit, handler, status: () => status };
}

describe('Telegram callback authorization and validation', () => {
  it.each([
    'order:0:confirm', 'order:-1:confirm', 'order:2147483648:confirm', 'order:0154:confirm',
    'order:154:cancel', 'order:154:deleteAll', 'order:154:confirm:ADMIN',
    'https://evil.example', 'order:1.5:confirm', 'order:154:confirm\n', 'x'.repeat(65),
  ])('rejects malformed commands %s without an order lookup', async data => {
    const s = setup();
    await s.handler.handle({ callback_query: callback(data) });
    expect(s.findUnique).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledExactlyOnceWith('query', 'Некорректная кнопка');
    expect(s.staff.confirm).not.toHaveBeenCalled();
  });

  it('uses allowlisted actor AND chat, not IDs or role inside payload', async () => {
    const s = setup();
    for (const query of [
      { ...callback(), from: { id: 999, is_bot: false } },
      { ...callback(), message: { ...callback().message, chat: { id: 999, type: 'private' } } },
      { ...callback(), from: { id: 456, is_bot: false }, role: 'ADMIN', userId: 1 },
    ]) await s.handler.handle({ callback_query: query });
    expect(s.staff.confirm).not.toHaveBeenCalled();
    expect(s.findUnique).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledTimes(3);
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Нет доступа');
  });

  it('allows a listed staff user in a listed group, never a random group member', async () => {
    const s = setup();
    const group = { ...callback(), message: { ...callback().message, chat: { id: -100456, type: 'supergroup' } } };
    await s.handler.handle({ callback_query: { ...group, from: { id: 999, is_bot: false } } });
    expect(s.findUnique).not.toHaveBeenCalled();
    await s.handler.handle({ callback_query: group });
    expect(s.staff.confirm).toHaveBeenCalledExactlyOnceWith(154);
  });

  it('ACKs invalid envelopes with a usable callback ID and ignores other updates', async () => {
    const s = setup();
    await s.handler.handle({ callback_query: { id: 'broken', data: 'order:154:confirm' } });
    expect(s.answer).toHaveBeenCalledExactlyOnceWith('broken', 'Некорректная кнопка');
    for (const value of [null, {}, { message: {} }, { edited_message: {} }, { callback_query: {} }])
      await s.handler.handle(value);
    expect(s.answer).toHaveBeenCalledTimes(1);
    expect(s.findUnique).not.toHaveBeenCalled();
  });

  it('has only whitelisted compact ASCII callback data and read-only terminal keyboards', () => {
    expect(parseAction('order:2147483647:confirm')?.orderId).toBe(2147483647);
    for (const status of ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELED'] as const) {
      const buttons = orderKeyboard(154, status, 'https://shop.example/staff/orders/154').inline_keyboard.flat();
      const actions = buttons.filter(button => 'callback_data' in button);
      expect(actions).toHaveLength(['NEW', 'CONFIRMED'].includes(status) ? 1 : 0);
      for (const button of actions) {
        if ('callback_data' in button) {
          expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
          expect(parseAction(button.callback_data)).not.toBeNull();
          expect(button.callback_data).not.toContain('cancel');
        }
      }
    }
    expect(orderKeyboard(154, 'NEW', 'https://shop.example', false).inline_keyboard).toHaveLength(1);
  });
});

describe('Telegram transitions', () => {
  it('confirms via StaffService, ACKs and refreshes current status; repeated confirm is harmless', async () => {
    const s = setup();
    await s.handler.handle({ callback_query: callback() });
    expect(s.staff.confirm).toHaveBeenCalledExactlyOnceWith(154);
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Заказ подтверждён');
    expect(s.edit).toHaveBeenLastCalledWith(123, 77, 154, 'CONFIRMED');
    await s.handler.handle({ callback_query: callback() });
    expect(s.staff.confirm).toHaveBeenCalledTimes(1);
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Статус заказа уже изменился');
  });

  it('starts assembly via StaffService and removes mutation buttons', async () => {
    const s = setup('CONFIRMED');
    await s.handler.handle({ callback_query: callback('order:154:assembly') });
    expect(s.staff.startAssembly).toHaveBeenCalledExactlyOnceWith(154);
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Сборка начата');
    expect(s.edit).toHaveBeenLastCalledWith(123, 77, 154, 'ASSEMBLING');
  });

  it.each(['cancel_request', 'cancel_confirm', 'cancel_back'])('never cancels without a linked audit actor: %s', async action => {
    const s = setup();
    await s.handler.handle({ callback_query: callback('order:154:' + action) });
    expect(s.staff.cancel).not.toHaveBeenCalled();
    expect(s.status()).toBe('NEW');
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Отмена доступна на сайте');
  });

  it('handles wrong status, missing order and row-lock conflict safely', async () => {
    const s = setup('CANCELED');
    await s.handler.handle({ callback_query: callback() });
    expect(s.staff.confirm).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Статус заказа уже изменился');
    s.findUnique.mockResolvedValueOnce(null!);
    await s.handler.handle({ callback_query: callback('order:999:confirm') });
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Заказ недоступен');
    const race = setup();
    race.staff.confirm.mockRejectedValueOnce(new BadRequestException('private details'));
    await race.handler.handle({ callback_query: callback() });
    expect(race.answer).toHaveBeenLastCalledWith('query', 'Статус заказа уже изменился');
  });

  it('preserves committed status when edit or ACK fails, without leaking provider secrets', async () => {
    fetcher.mockRejectedValue(new Error(process.env.TELEGRAM_BOT_TOKEN + ' private customer'));
    const s = setup();
    await expect(s.handler.handle({ callback_query: callback() })).resolves.toBeUndefined();
    expect(s.status()).toBe('CONFIRMED');
    expect(s.answer).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Telegram keyboard update failed for order 154');
    const logs = JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls);
    expect(logs.includes(process.env.TELEGRAM_BOT_TOKEN!)).toBe(false);
    expect(logs).not.toContain('private customer');
  });

  it('ACKs and surfaces programming failures as sanitized 500 instead of hiding them', async () => {
    const s = setup();
    s.staff.confirm.mockRejectedValueOnce(new Error(process.env.TELEGRAM_WEBHOOK_SECRET));
    await expect(s.handler.handle({ callback_query: callback() })).rejects.toMatchObject({
      status: 500, message: 'Telegram update failed',
    });
    expect(s.answer).toHaveBeenLastCalledWith('query', 'Не удалось выполнить действие');
    expect(Logger.prototype.error).toHaveBeenCalledWith('Telegram callback processing failed');
  });

  it('uses real StaffService locking logic under concurrent repeated clicks', async () => {
    let status: OrderStatus = 'NEW';
    let lock: Promise<unknown> = Promise.resolve();
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 154 }]),
      order: {
        findUnique: vi.fn(async () => ({ id: 154, status })),
        update: vi.fn(async ({ data }: { data: { status: OrderStatus } }) => {
          status = data.status; return { id: 154, status };
        }),
      },
    };
    const db = {
      ...client,
      $transaction: (fn: (tx: typeof client) => Promise<unknown>) => {
        const next = lock.then(() => fn(client));
        lock = next.catch(() => {});
        return next;
      },
    } as unknown as DbService;
    const staff = new StaffService(db, {} as NotificationService);
    const telegram = new TelegramService(db);
    const handler = new TelegramUpdateService(db, staff, telegram);
    await Promise.all([handler.handle({ callback_query: callback() }), handler.handle({ callback_query: callback() })]);
    expect(status).toBe('CONFIRMED');
    expect(client.order.update).toHaveBeenCalledTimes(1);
    expect(client.$queryRaw).toHaveBeenCalled();
    await Promise.all([
      handler.handle({ callback_query: callback('order:154:assembly') }),
      handler.handle({ callback_query: callback('order:154:assembly') }),
    ]);
    expect(status).toBe('ASSEMBLING');
    expect(client.order.update).toHaveBeenCalledTimes(2);
  });
});
