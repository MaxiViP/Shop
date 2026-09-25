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
  [403, {}, 'blocked'], [429, {}, 'rejected'], [500, {}, 'unknown'],
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
  const body = JSON.parse(String(options?.body)) as { text: string; parse_mode?: string };
  expect(body.parse_mode).toBeUndefined();
  expect(body.text).toContain('Заказ №7\nНовое сообщение от продавца');
  expect(body.text).toContain(notice.message!.text);
  expect(String(options?.body)).toContain('https://shop.example/order/' + notice.order.publicId);
  expect(String(options?.body)).toContain(notice.order.publicId.replaceAll('-', ''));
  expect(body.text.length).toBeLessThan(4096);
});
it('fails availability in legacy shared-bot mode', () => {
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', process.env.TELEGRAM_CUSTOMER_BOT_TOKEN!);
  expect(new CustomerNotificationService().available).toBe(false);
});
