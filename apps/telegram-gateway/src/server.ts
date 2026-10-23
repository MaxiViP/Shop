import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const host = '127.0.0.1';
export const port = 18080;
export const bodyLimit = 64 * 1024;
export const uploadLimit = 2 * 1024 * 1024;
const responseLimit = 256 * 1024;
const methods = new Set(['sendMessage', 'sendRichMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText']);
type Tokens = { customer?: string; staff?: string };
type Options = { tokens: Tokens; fetcher?: typeof fetch; timeoutMs?: number };

class InputError extends Error {
  constructor(readonly status: number) { super('GATEWAY_INPUT'); }
}

function attachments(blocks: unknown[], names: string[], state = { count: 0 }, depth = 0): void {
  if (depth > 4) throw new InputError(400);
  for (const block of blocks) {
    if (++state.count > 40 || !block || typeof block !== 'object' || !('type' in block)) throw new InputError(400);
    if (block.type === 'photo') {
      if (!('photo' in block) || !block.photo || typeof block.photo !== 'object' || !('media' in block.photo) || typeof block.photo.media !== 'string') throw new InputError(400);
      if (block.photo.media.startsWith('attach://')) {
        const name = block.photo.media.slice(9);
        if (!/^photo[1-7]?$/.test(name)) throw new InputError(400);
        names.push(name);
      }
    } else if (block.type === 'collage' || block.type === 'details') {
      if (!('blocks' in block) || !Array.isArray(block.blocks)) throw new InputError(400);
      attachments(block.blocks, names, state, depth + 1);
    }
  }
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

async function payload(request: IncomingMessage, method: string): Promise<{ body: string | Uint8Array<ArrayBuffer>; contentType: string }> {
  const contentType = request.headers['content-type'] ?? '';
  const multipart = /^multipart\/form-data;\s*boundary=(?:[A-Za-z0-9_-]{1,70}|"[A-Za-z0-9_-]{1,70}")$/i.test(contentType);
  if ((!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) && !multipart) ||
      (multipart && !['sendRichMessage', 'editMessageText'].includes(method)) ||
      (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity'))
    throw new InputError(415);
  const limit = multipart ? uploadLimit : bodyLimit;
  const length = request.headers['content-length'];
  if (length && Number(length) > limit) throw new InputError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new InputError(400);
    size += chunk.length;
    if (size > limit) throw new InputError(413);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(Buffer.concat(chunks));
  if (multipart) {
    let form: FormData;
    try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
    catch { throw new InputError(400); }
    const keys = [...form.keys()];
    if (keys.length !== new Set(keys).size || keys.some(key => !['chat_id', 'message_id', 'rich_message'].includes(key) && !/^photo[1-7]?$/.test(key)) ||
        !/^[1-9]\d{0,15}$/.test(String(form.get('chat_id'))) ||
        (method === 'editMessageText' && !/^[1-9]\d{0,9}$/.test(String(form.get('message_id'))))) throw new InputError(400);
    const files = keys.filter(key => /^photo[1-7]?$/.test(key)), rich = form.get('rich_message');
    if (!files.length || typeof rich !== 'string' || Buffer.byteLength(rich) > 48 * 1024) throw new InputError(400);
    for (const name of files) {
      const photo = form.get(name);
      if (!photo || typeof photo === 'string' || photo.type !== 'image/jpeg' || photo.size < 3 || photo.size > 1024 * 1024) throw new InputError(400);
      const magic = new Uint8Array(await photo.slice(0, 2).arrayBuffer());
      if (magic[0] !== 255 || magic[1] !== 216) throw new InputError(400);
    }
    let value: unknown;
    try { value = JSON.parse(rich); } catch { throw new InputError(400); }
    if (!value || typeof value !== 'object' || !('blocks' in value) || !Array.isArray(value.blocks)) throw new InputError(400);
    const names: string[] = [];
    attachments(value.blocks, names);
    if (names.length !== files.length || names.length !== new Set(names).size || names.some(name => !files.includes(name))) throw new InputError(400);
    return { body: bytes, contentType };
  }
  const text = Buffer.from(bytes).toString('utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InputError(400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(400);
  return { body: text, contentType: 'application/json' };
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
    let input: Awaited<ReturnType<typeof payload>>;
    try { input = await payload(request, method); }
    catch (error) {
      reply(response, error instanceof InputError ? error.status : 400, '{"ok":false,"error":"INVALID_REQUEST"}');
      return;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      // Exactly one attempt. Neither exceptions nor downstream disconnects trigger a resend.
      const upstream = await fetcher('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST', headers: { 'Content-Type': input.contentType },
        body: input.body, redirect: 'error', signal,
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
