import { randomUUID } from 'node:crypto';
import { customerPrompt, customerShow } from './customer-send.js';
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', '');
  vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 91 } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('opens a reply-bound input while preserving cancel and menu navigation', async () => {
  expect(await customerPrompt(123, 'Введите имя')).toBe(91);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.reply_markup.force_reply).toBe(true);
  expect(body.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
    { text: 'Отменить ввод', callback_data: 'cancel' }, { text: 'Меню', callback_data: 'menu' },
  ]));
  expect(body).not.toHaveProperty('parse_mode');
});
it('keeps an unknown prompt unbound instead of resending it', async () => {
  fetcher.mockRejectedValueOnce(new Error('network'));
  expect(await customerPrompt(123, 'Введите имя')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('recovers an explicitly deleted buyer card without replaying any domain action', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ ok: false, error_code: 400,
    description: 'Bad Request: message to edit not found' }, { status: 400 }));
  expect(await customerShow({ chatId: 123, messageId: 91 }, {
    text: 'Актуальный заказ', keyboard: { inline_keyboard: [[{ text: 'Меню', callback_data: 'menu' }]] },
  })).toBe(true);
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls.every(([, options]) => !JSON.parse(String(options?.body)).parse_mode)).toBe(true);
});
