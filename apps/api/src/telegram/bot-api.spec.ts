import { randomUUID } from 'node:crypto';
import { botDelivery, botMessage, botRequest, botSendMessageId, type BotMethod } from './bot-api.js';
import { customerBotToken, staffBotToken } from './bot-config.js';

const fetcher = vi.fn<typeof fetch>();
const customer = randomUUID(), staff = randomUUID(), legacy = randomUUID();
const gateway = 'http://127.0.0.1:19001';
const methods: BotMethod[] = ['sendMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'];
beforeEach(() => {
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', customer);
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', staff);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', legacy);
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', '');
  vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
  fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 91 } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['customer', 'staff'] as const)('keeps %s direct behavior unchanged without gateway config', async bot => {
  const token = bot === 'customer' ? customer : staff;
  expect(await botDelivery(token, { text: 'fixture' })).toBe('sent');
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url === 'https://api.telegram.org/bot' + token + '/sendMessage').toBe(true);
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retains legacy token fallbacks with direct mode', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', '');
  expect(customerBotToken() === legacy && staffBotToken() === legacy).toBe(true);
  expect(await botDelivery(customerBotToken(), {})).toBe('sent');
});
it.each(methods)('routes CUSTOMER %s only to the gateway with no token in URL, headers or body', async method => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  expect(await botRequest(customer, method, { text: 'fixture' })).toBe(true);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe(gateway + '/v1/customer/' + method);
  expect([customer, staff, legacy].some(secret => JSON.stringify(fetcher.mock.calls).includes(secret))).toBe(false);
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
});
it('CUSTOMER migration leaves STAFF direct', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  await botRequest(staff, 'answerCallbackQuery', {});
  expect(fetcher.mock.calls[0]![0] === 'https://api.telegram.org/bot' + staff + '/answerCallbackQuery').toBe(true);
});
it('STAFF-only migration leaves CUSTOMER direct', async () => {
  vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', gateway);
  await botDelivery(customer, {});
  expect(fetcher.mock.calls[0]![0] === 'https://api.telegram.org/bot' + customer + '/sendMessage').toBe(true);
});
it.each(methods)('routes STAFF %s to its own gateway', async method => {
  vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', 'http://127.0.0.1:19003/');
  expect(await botRequest(staff, method, {})).toBe(true);
  expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:19003/v1/staff/' + method);
});
it('selects distinct bots even when both use the same gateway origin', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', gateway);
  await botDelivery(customer, {});
  await botDelivery(staff, {});
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([gateway + '/v1/customer/sendMessage', gateway + '/v1/staff/sendMessage']);
});
it.each(['CUSTOMER', 'STAFF'] as const)('resolves a unique %s legacy fallback safely', async bot => {
  vi.stubEnv('TELEGRAM_' + bot + '_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_' + bot + '_GATEWAY_URL', gateway);
  expect(await botDelivery(legacy, {})).toBe('sent');
  expect(fetcher.mock.calls[0]![0]).toBe(gateway + '/v1/' + bot.toLowerCase() + '/sendMessage');
});
it.each(['CUSTOMER', 'STAFF'] as const)('fails closed on an ambiguous shared token with %s gateway enabled', async bot => {
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_' + bot + '_GATEWAY_URL', gateway);
  expect(await botDelivery(legacy, {})).toBe('rejected');
  expect(fetcher).not.toHaveBeenCalled();
});
it('fails closed for an unknown token when gateway mode is configured', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  expect(await botDelivery(randomUUID(), {})).toBe('rejected');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([' ', 'invalid', 'https://example.com', 'http://localhost:19001', 'http://127.0.0.1:0',
  'http://127.0.0.1:99999', 'http://127.0.0.1:19001/extra', 'http://127.0.0.1:19001?x=1',
  'http://127.0.0.1:19001/#x', 'http://fixture@127.0.0.1:19001'])('fails closed for invalid gateway URL %#', async url => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', url);
  expect(await botDelivery(customer, {})).toBe('rejected');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['timeout', 'reset', '500', '502', '503', '504', 'malformed', 'missing-id'] as const)(
  'gateway %s remains UNKNOWN with no direct fallback or resend', async kind => {
    vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
    if (kind === 'timeout') fetcher.mockRejectedValueOnce(new DOMException(customer, 'TimeoutError'));
    else if (kind === 'reset') fetcher.mockRejectedValueOnce(new Error(customer));
    else if (kind === 'malformed') fetcher.mockResolvedValueOnce(new Response('invalid JSON'));
    else if (kind === 'missing-id') fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    else fetcher.mockResolvedValueOnce(new Response('', { status: Number(kind) }));
    expect(await botDelivery(customer, {})).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(gateway + '/v1/customer/sendMessage');
  },
);
it.each([
  [403, {}, 'blocked'], [400, {}, 'rejected'], [401, {}, 'rejected'], [429, {}, 'rejected'],
  [200, { ok: false, error_code: 403 }, 'blocked'], [200, { ok: false, error_code: 400 }, 'rejected'],
  [200, { ok: false }, 'unknown'],
])('preserves gateway rejection classification %#', async (status, body, expected) => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  fetcher.mockResolvedValueOnce(Response.json(body, { status }));
  expect(await botDelivery(customer, {})).toBe(expected);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('message helpers preserve the real sent Message ID', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  expect(await botSendMessageId(customer, {})).toBe(91);
  expect(await botMessage(customer, 'sendMessage', {})).toBe(true);
  expect(await botMessage(customer, 'editMessageText', {})).toBe(true);
});
it.each([undefined, null, true, {}, { message_id: '91' }, { message_id: 0 }, { message_id: -1 },
  { message_id: 1.5 }, { message_id: Number.MAX_SAFE_INTEGER + 1 }])(
  'malformed gateway Message %# is never positive delivery', async result => {
    vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
    fetcher.mockImplementation(async () => Response.json({ ok: true, result }));
    expect(await botSendMessageId(customer, {})).toBeNull();
    expect(await botMessage(customer, 'sendMessage', {})).toBe(false);
    expect(await botDelivery(customer, {})).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(3); // one per explicit call, no retries
  },
);
it('keeps simple callback success semantics for result:true', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: true }));
  expect(await botRequest(customer, 'answerCallbackQuery', {})).toBe(true);
});
it('does not log provider exceptions or token values', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  fetcher.mockRejectedValueOnce(new Error(customer + ' private fixture'));
  expect(await botSendMessageId(customer, {})).toBeNull();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it('rejects a method outside the fixed BotMethod allowlist', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  expect(await botRequest(customer, 'setWebhook' as BotMethod, {})).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([502, 503, 504])('gateway internal HTTP %i stays UNKNOWN even with misleading Telegram error_code', async status => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  fetcher.mockImplementation(async () => Response.json({ ok: false, error_code: 403 }, { status }));
  expect(await botDelivery(customer, {})).toBe('unknown');
  expect(await botMessage(customer, 'sendMessage', {})).toBe(false);
  expect(await botSendMessageId(customer, {})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([url]) => url === gateway + '/v1/customer/sendMessage')).toBe(true);
});
it('retains seven-second delivery deadlines and the explicit short callback deadline', async () => {
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await botDelivery(customer, {});
  await botMessage(customer, 'sendMessage', {});
  await botSendMessageId(customer, {});
  await botRequest(customer, 'answerCallbackQuery', {}, 3000);
  expect(timeout.mock.calls).toEqual([[7000], [7000], [7000], [3000]]);
});
