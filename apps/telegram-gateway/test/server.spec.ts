import { randomBytes } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyLimit, createGateway, host, port } from '../src/server.js';

const tokens = {
  customer: '100000:' + randomBytes(32).toString('hex'),
  staff: '200000:' + randomBytes(32).toString('hex'),
};
const upstream = vi.fn<typeof fetch>();
let server: Server;
let origin: string;
async function start(options: Parameters<typeof createGateway>[0] = { tokens, fetcher: upstream }) {
  server = createGateway(options);
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_LISTENER');
  expect(address.address).toBe('127.0.0.1');
  origin = 'http://127.0.0.1:' + address.port;
}
const send = (path = '/v1/customer/sendMessage', body = '{"chat_id":123,"text":"fixture"}', headers = { 'Content-Type': 'application/json' }) =>
  fetch(origin + path, { method: 'POST', headers, body });

beforeEach(() => {
  upstream.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 37 } }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('health is generic even without tokens and never contacts Telegram', async () => {
  await start({ tokens: {}, fetcher: upstream });
  expect(host).toBe('127.0.0.1');
  expect(port).toBe(18080);
  const response = await fetch(origin + '/health');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"ok":true}');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(upstream).not.toHaveBeenCalled();
});

describe.each(['customer', 'staff'] as const)('%s explicit upstream identity', bot => {
  it.each(['sendMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'])('allows only POST %s', async method => {
    await start();
    const incoming = '/v1/' + bot + '/' + method;
    expect(incoming.includes(tokens.customer) || incoming.includes(tokens.staff)).toBe(false);
    const body = { chat_id: 123, text: 'fixture', reply_markup: { force_reply: true } };
    const response = await send(incoming, JSON.stringify(body));
    expect(await response.json()).toEqual({ ok: true, result: { message_id: 37 } });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, options] = upstream.mock.calls[0]!;
    expect(url === 'https://api.telegram.org/bot' + tokens[bot] + '/' + method).toBe(true);
    expect(options).toMatchObject({
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal), body: JSON.stringify(body),
    });
  });
  it('fails safely when its token is missing', async () => {
    await start({ tokens: { ...tokens, [bot]: undefined }, fetcher: upstream });
    const response = await send('/v1/' + bot + '/sendMessage');
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ok":false,"error":"BOT_UNAVAILABLE"}');
    expect(upstream).not.toHaveBeenCalled();
  });
});

it.each([
  '/v1/other/sendMessage', '/v1/customer/getUpdates', '/v1/customer/setWebhook',
  '/v1/customer/sendMessage?url=https://example.com', '/v1/customer/sendMessage/',
  '/v1/customer/%73endMessage', '/api/telegram/customer/webhook', '/api/telegram/webhook',
  '/https://api.telegram.org/sendMessage',
])('rejects unrecognized route %s', async path => {
  await start();
  expect((await send(path)).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});
it.each(['GET', 'PUT', 'DELETE'])('does not forward HTTP %s', async method => {
  await start();
  expect((await fetch(origin + '/v1/customer/sendMessage', { method })).status).toBe(405);
  expect(upstream).not.toHaveBeenCalled();
});
it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])('rejects %s', async type => {
  await start();
  expect((await send(undefined, '{}', { 'Content-Type': type })).status).toBe(415);
  expect(upstream).not.toHaveBeenCalled();
});
it.each(['{', 'null', '[]', '"text"', '42', ''])('rejects non-object JSON %#', async body => {
  await start();
  expect((await send(undefined, body)).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
it('accepts a JSON UTF-8 charset but no compressed input', async () => {
  await start();
  expect((await send(undefined, '{}', { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200);
  const response = await fetch(origin + '/v1/customer/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: '{}',
  });
  expect(response.status).toBe(415);
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('rejects an oversized Content-Length before any upstream request', async () => {
  await start();
  expect((await send(undefined, JSON.stringify({ text: 'x'.repeat(bodyLimit) }))).status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it('enforces the same limit on chunked bodies without Content-Length', async () => {
  await start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(origin + '/v1/customer/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write('{"text":"');
    request.end('x'.repeat(bodyLimit) + '"}');
  });
  expect(status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it.each([200, 400, 403, 429, 500])('preserves Telegram HTTP %i and its body, without upstream headers', async status => {
  await start();
  const text = status === 200 ? '{"ok":true,"result":{"message_id":97}}' :
    '{"ok":false,"error_code":' + status + ',"description":"provider fixture"}';
  upstream.mockResolvedValueOnce(new Response(text, { status, headers: { 'Set-Cookie': 'fixture', Location: 'https://example.com' } }));
  const response = await send();
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(text);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('location')).toBeNull();
  expect(upstream).toHaveBeenCalledTimes(1);
});
it.each(['{"ok":true}', '{"ok":true,"result":{}}', '{"ok":true,"result":{"message_id":"37"}}', 'malformed'])(
  'never fabricates a message_id for malformed success %#', async body => {
    await start();
    upstream.mockResolvedValueOnce(new Response(body));
    const response = await send();
    expect(await response.text()).toBe(body);
    expect(upstream).toHaveBeenCalledTimes(1);
  },
);
it('timeout returns static 504 and makes exactly one attempt', async () => {
  await start({ tokens, fetcher: upstream, timeoutMs: 10 });
  upstream.mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error(tokens.customer)), { once: true });
  }));
  const response = await send();
  expect(response.status).toBe(504);
  expect(await response.text()).toBe('{"ok":false,"error":"UPSTREAM_UNKNOWN"}');
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('network failure returns static 502 and logs neither exceptions nor payloads', async () => {
  await start();
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  upstream.mockRejectedValueOnce(new Error('https://api.telegram.org/bot' + tokens.customer + '/sendMessage private fixture'));
  const response = await send();
  expect(response.status).toBe(502);
  expect(await response.text()).toBe('{"ok":false,"error":"UPSTREAM_UNKNOWN"}');
  expect(upstream).toHaveBeenCalledTimes(1);
  for (const logger of logs) expect(logger).not.toHaveBeenCalled();
});
it.each(['raw', 'JSON string', 'unicode', 'JSON unicode', 'mixed'] as const)('never relays or logs an echoed credential with %s encoding', async encoding => {
  await start();
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  for (const log of logs) log.mockImplementation(() => {});
  const escaped = [...tokens.staff].map((char, index) => encoding === 'mixed' && index % 2 === 0
    ? char : '\\u' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
  const body = encoding === 'raw' ? tokens.staff : encoding === 'JSON string'
    ? JSON.stringify({ ok: false, description: JSON.stringify({ nested: tokens.staff }) })
    : encoding === 'JSON unicode' ? JSON.stringify({ ok: false, description: escaped })
    : '{"ok":false,"description":"' + escaped + '"}';
  upstream.mockResolvedValueOnce(new Response(body, { status: 500 }));
  const response = await send();
  expect(response.status).toBe(502);
  // Boolean assertions keep provider content out of assertion diagnostics on regression.
  expect((await response.text()) === '{"ok":false,"error":"UPSTREAM_UNKNOWN"}').toBe(true);
  expect(logs.reduce((count, log) => count + log.mock.calls.length, 0)).toBe(0);
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('bounds upstream response size without retrying', async () => {
  await start();
  upstream.mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1)));
  expect((await send()).status).toBe(502);
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('a response body read failure remains UNKNOWN', async () => {
  await start();
  upstream.mockResolvedValueOnce(new Response(new ReadableStream({
    start(controller) { controller.error(new Error(tokens.customer)); },
  })));
  const response = await send();
  expect(response.status).toBe(502);
  expect(await response.text()).toBe('{"ok":false,"error":"UPSTREAM_UNKNOWN"}');
  expect(upstream).toHaveBeenCalledTimes(1);
});
it.each([' ', 'invalid/path', 'invalid?query'])('rejects invalid token configuration %# without upstream I/O', async customer => {
  await start({ tokens: { ...tokens, customer }, fetcher: upstream });
  expect((await send()).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});
it('rejects shared customer/staff tokens without choosing a different bot', async () => {
  await start({ tokens: { customer: tokens.customer, staff: tokens.customer }, fetcher: upstream });
  expect((await send()).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

it('does not relay a credential hidden by JSON unicode escaping', async () => {
  await start();
  const escaped = [...tokens.customer].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  upstream.mockResolvedValueOnce(new Response('{"ok":false,"description":"' + escaped + '"}', { status: 500 }));
  const response = await send();
  expect(response.status).toBe(502);
  expect(await response.text()).toBe('{"ok":false,"error":"UPSTREAM_UNKNOWN"}');
  expect(upstream).toHaveBeenCalledTimes(1);
});

it.each(['duplicate-field', 'malformed'] as const)('never relays an escaped credential in %s JSON', async kind => {
  await start();
  const escaped = [...tokens.customer].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const body = kind === 'duplicate-field'
    ? '{"description":"' + escaped + '","description":"fixture","ok":false}'
    : '{"description":"' + escaped + '"';
  upstream.mockResolvedValueOnce(new Response(body, { status: 500 }));
  const response = await send();
  expect(response.status).toBe(502);
  expect(await response.text()).toBe('{"ok":false,"error":"UPSTREAM_UNKNOWN"}');
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('uses a five-second upstream deadline by default', async () => {
  await start();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  expect((await send()).status).toBe(200);
  expect(timeout.mock.calls).toEqual([[5000]]);
});
it('health remains static when configured Telegram transport is down', async () => {
  await start();
  upstream.mockRejectedValue(new Error('fixture unavailable'));
  const response = await fetch(origin + '/health');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"ok":true}');
  expect(upstream).not.toHaveBeenCalled();
});
it.each(['HEAD', 'POST', 'OPTIONS'])('health does not accept %s', async method => {
  await start();
  expect((await fetch(origin + '/health', { method })).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});
it('payload fields cannot override destination, method or object prototypes', async () => {
  await start();
  const body = '{"__proto__":{"gatewayPolluted":true},"url":"https://example.invalid","method":"getUpdates","text":"fixture"}';
  expect((await send('/v1/customer/sendMessage', body)).status).toBe(200);
  const [url, options] = upstream.mock.calls[0]!;
  expect(url === 'https://api.telegram.org/bot' + tokens.customer + '/sendMessage').toBe(true);
  expect(options?.method).toBe('POST');
  expect(options?.body).toBe(body);
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'gatewayPolluted')).toBe(false);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it('CUSTOMER cutover works with no STAFF token on the gateway', async () => {
  await start({ tokens: { customer: tokens.customer }, fetcher: upstream });
  expect((await send()).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0]![0] === 'https://api.telegram.org/bot' + tokens.customer + '/sendMessage').toBe(true);
  expect((await send('/v1/staff/sendMessage')).status).toBe(503);
  expect(upstream).toHaveBeenCalledTimes(1);
});
