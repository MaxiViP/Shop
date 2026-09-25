import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const host = '127.0.0.1';
export const port = 18080;
export const bodyLimit = 64 * 1024;
const responseLimit = 256 * 1024;
const methods = new Set(['sendMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText']);
type Tokens = { customer?: string; staff?: string };
type Options = { tokens: Tokens; fetcher?: typeof fetch; timeoutMs?: number };

class InputError extends Error {
  constructor(readonly status: number) { super('GATEWAY_INPUT'); }
}

function reply(response: ServerResponse, status: number, body: string) {
  if (response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Close invalid requests without draining an unbounded/untrusted upload.
    ...(status >= 400 ? { Connection: 'close' } : {}),
  });
  response.end(body);
}

async function payload(request: IncomingMessage): Promise<string> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
      (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity'))
    throw new InputError(415);
  const length = request.headers['content-length'];
  if (length && Number(length) > bodyLimit) throw new InputError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new InputError(400);
    size += chunk.length;
    if (size > bodyLimit) throw new InputError(413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InputError(400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(400);
  return text;
}

async function upstreamBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > responseLimit) {
        await reader.cancel();
        throw new Error('GATEWAY_RESPONSE_LIMIT');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export function createGateway({ tokens, fetcher = fetch, timeoutMs = 5000 }: Options) {
  // No legacy token fallback at this boundary. Each path has an explicit bot identity.
  const configured = { customer: tokens.customer?.trim() ?? '', staff: tokens.staff?.trim() ?? '' };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method === 'GET' && request.url === '/health') {
      reply(response, 200, '{"ok":true}');
      return;
    }
    const route = /^\/v1\/(customer|staff)\/([A-Za-z]+)$/.exec(request.url ?? '');
    const bot = route?.[1];
    const method = route?.[2];
    if ((bot !== 'customer' && bot !== 'staff') || !method || !methods.has(method)) {
      reply(response, 404, '{"ok":false,"error":"NOT_FOUND"}');
      return;
    }
    if (request.method !== 'POST') {
      reply(response, 405, '{"ok":false,"error":"METHOD_NOT_ALLOWED"}');
      return;
    }
    const token = configured[bot];
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token) || configured.customer === configured.staff) {
      reply(response, 503, '{"ok":false,"error":"BOT_UNAVAILABLE"}');
      return;
    }
    let body: string;
    try { body = await payload(request); }
    catch (error) {
      reply(response, error instanceof InputError ? error.status : 400, '{"ok":false,"error":"INVALID_REQUEST"}');
      return;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      // Exactly one attempt. Neither exceptions nor downstream disconnects trigger a resend.
      const upstream = await fetcher('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, redirect: 'error', signal,
      });
      const text = await upstreamBody(upstream);
      // Preserve Telegram bodies/statuses, but never relay a credential even if echoed upstream.
      // Inspect escapes in the raw body too: JSON.parse would discard duplicate
      // object fields; malformed/nested JSON can still contain escaped credentials.
      const decoded = text.replace(/\\+u([0-9a-f]{4})/gi,
        (_escape, hex: string) => String.fromCharCode(Number('0x' + hex)));
      if (Object.values(configured).some(secret => secret && (text.includes(secret) || decoded.includes(secret))))
        throw new Error('GATEWAY_RESPONSE_CREDENTIAL');
      reply(response, upstream.status, text);
    } catch {
      reply(response, signal.aborted ? 504 : 502, '{"ok":false,"error":"UPSTREAM_UNKNOWN"}');
    }
  }
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 5000 },
    (request, response) => {
      void handle(request, response).catch(() => reply(response, 502, '{"ok":false,"error":"GATEWAY_UNKNOWN"}'));
    });
  server.maxHeadersCount = 32;
  return server;
}
