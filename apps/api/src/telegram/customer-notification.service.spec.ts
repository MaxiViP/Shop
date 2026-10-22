import { randomUUID } from 'node:crypto';
import { botDelivery } from './bot-api.js';
import { CustomerNotificationService, type CustomerNotice } from './customer-notification.service.js';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_CUSTOMER_WEBHOOK_SECRET', randomUUID());
  vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', randomUUID());
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 123 } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each([
  [200, { ok: true, result: { message_id: 123 } }, 'sent'], [400, {}, 'rejected'], [401, {}, 'rejected'],
  [403, {}, 'blocked'], [429, {}, 'retryable'], [500, {}, 'unknown'],
  [200, { ok: false, error_code: 403 }, 'blocked'], [200, { garbage: true }, 'unknown'],
])('classifies HTTP %s safely without returning provider data', async (status, body, expected) => {
  fetcher.mockResolvedValueOnce(Response.json(body, { status }));
  expect(await botDelivery(randomUUID(), { text: 'fixture' })).toBe(expected);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
});
it.each([undefined, null, true, {}, { message_id: '123' }, { message_id: 0 }, { message_id: -1 }, { message_id: 1.5 }, { message_id: Number.MAX_SAFE_INTEGER + 1 }])(
  'does not confirm delivery from a malformed successful response %#', async result => {
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, result }));
    expect(await botDelivery(randomUUID(), {})).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('does not retry a network exception with an unknown outcome', async () => {
  fetcher.mockRejectedValueOnce(new Error('synthetic private body'));
  expect(await botDelivery(randomUUID(), {})).toBe('unknown');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('customer provider uses the customer token and bounded plain-text message', async () => {
  const service = new CustomerNotificationService();
  expect(service.available).toBe(true);
  const notice: CustomerNotice = {
    event: { type: 'CHAT_MESSAGE' }, order: { id: 7, publicId: '11111111-1111-4111-8111-111111111111', finalSubtotal: null, finalTotal: null, delivery: null },
    message: { text: '<b> & test\n' + 'Я'.repeat(1950) }, issue: null,
  };
  await service.send('12345', notice);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.telegram.org/bot' + process.env.TELEGRAM_CUSTOMER_BOT_TOKEN + '/sendMessage');
  const body = JSON.parse(String(options?.body)) as { text: string; parse_mode?: string;
    reply_markup: { inline_keyboard: { text: string; web_app?: { url: string } }[][] } };
  expect(body.parse_mode).toBeUndefined();
  expect(body.text).toContain('Заказ №7\nНовое сообщение от продавца');
  expect(body.text).toContain(notice.message!.text);
  expect(body.reply_markup.inline_keyboard.flat().find(button => button.text === 'Открыть заказ на сайте')?.web_app?.url)
    .toBe('https://shop.example/telegram?returnTo=' + encodeURIComponent('/order/' + notice.order.publicId));
  expect(String(options?.body)).toContain(notice.order.publicId.replaceAll('-', ''));
  expect(body.text.length).toBeLessThan(4096);
});
it('uses the committed issue message in one customer action-required notice', async () => {
  const notice: CustomerNotice = {
    event: { type: 'ACTION_REQUIRED' },
    order: { id: 7, publicId: '11111111-1111-4111-8111-111111111111', finalSubtotal: null, finalTotal: null, delivery: null },
    issue: { type: 'MISSING_ITEM' }, message: { text: 'Клубника — нет в наличии.' },
  };
  await new CustomerNotificationService().send('12345', notice);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { text: string };
  expect(body.text).toContain('Клубника — нет в наличии.');
  expect(body.text.match(/Клубника/g)).toHaveLength(1);
});
it('describes an image-only chat message in Telegram without exposing the private file', async () => {
  const notice: CustomerNotice = {
    event: { type: 'CHAT_MESSAGE' },
    order: { id: 7, publicId: '11111111-1111-4111-8111-111111111111', finalSubtotal: null, finalTotal: null, delivery: null },
    issue: null, message: { text: '' },
  };
  await new CustomerNotificationService().send('12345', notice);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { text: string };
  expect(body.text).toContain('Фото по заказу');
  expect(body.text).not.toContain('/uploads/');
});
it('fails availability in legacy shared-bot mode', () => {
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', process.env.TELEGRAM_CUSTOMER_BOT_TOKEN!);
  expect(new CustomerNotificationService().available).toBe(false);
});

it('opens authoritative payment details directly and distinguishes goods due from the delivery-inclusive total', async () => {
  await new CustomerNotificationService().send('12345', { event: { type: 'PAYMENT_READY' },
    order: { id: 7, publicId: '11111111-1111-4111-8111-111111111111', type: 'DELIVERY',
      finalSubtotal: 100000, finalTotal: 105000, deliveryPrice: 15000, promoCodeSnapshot: 'SAVE',
      finalPromoDiscount: 10000, payment: { amount: 90000, status: 'AWAITING' }, delivery: null },
    issue: null, message: null });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.text).toContain('К переводу за товары: 900');
  expect(body.text).toContain('Поступление денег подтвердит продавец');
  expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: '💳 Открыть оплату', style: 'primary' });
  expect(body.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^s:p:/);
  expect(body.text).not.toContain('Я оплатил');
});
it('completed orders offer quick shopping through a read-only entry and never repeat a mutation', async () => {
  await new CustomerNotificationService().send('12345', { event: { type: 'ORDER_COMPLETED' },
    order: { id: 7, publicId: '11111111-1111-4111-8111-111111111111', finalSubtotal: 50000, finalTotal: 50000, delivery: null },
    issue: null, message: null });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.text).toContain('по текущим ценам');
  expect(body.reply_markup.inline_keyboard[0][0].web_app.url).toBe(
    'https://shop.example/telegram?returnTo=' + encodeURIComponent('/quick-shop'));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('a fully covered order never asks the buyer to transfer money', async () => {
  await new CustomerNotificationService().send('12345', { event: { type: 'PAYMENT_RECEIVED' },
    order: { id: 7, publicId: '11111111-1111-4111-8111-111111111111', type: 'PICKUP',
      finalSubtotal: 50000, finalTotal: 0, payment: { amount: 0, status: 'PAID' }, delivery: null },
    issue: null, message: null });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.text).toContain('Перевод за товары не требуется');
  expect(body.reply_markup.inline_keyboard.flat().some((button: { callback_data?: string }) =>
    button.callback_data?.startsWith('s:p:'))).toBe(false);
});
