import { customerBotToken, staffBotToken } from './bot-config.js';

const methods = ['sendMessage', 'sendRichMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'] as const;
export type BotMethod = typeof methods[number];

type DeliveryStatus = 'sent' | 'rejected' | 'blocked' | 'retryable' | 'unknown';
export type BotDelivery = DeliveryStatus | { status: 'retryable'; retryAfter: number };

function retryAfter(body: unknown): number | undefined {
  if (!body || typeof body !== 'object' || !('parameters' in body)) return;
  const params = body.parameters;
  if (!params || typeof params !== 'object' || !('retry_after' in params)) return;
  const seconds = params.retry_after;
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 2_147_483_647
    ? seconds : undefined;
}

// Only definite edit rejections can be reconciled. A transport timeout never
// proves an edit failed, so it must not trigger a second message.
function editState(method: BotMethod, body: unknown): 'unchanged' | 'uneditable' | undefined {
  if (!['editMessageText', 'editMessageReplyMarkup'].includes(method) || !body ||
    typeof body !== 'object' || !('ok' in body) || body.ok !== false ||
    !('error_code' in body) || body.error_code !== 400 ||
    !('description' in body) || typeof body.description !== 'string') return;
  const description = body.description.toLowerCase();
  if (/^bad request: message is not modified(?:$|:)/.test(description)) return 'unchanged';
  if (method === 'editMessageText' && ['bad request: message to edit not found',
    "bad request: message can't be edited"].includes(description)) return 'uneditable';
}

// One destination is selected before sending. A failed gateway request must NEVER
// fall back to Telegram: the first request may already have reached the bot.
function destination(token: string, method: BotMethod): string | null {
  if (!methods.includes(method)) return null;
  const customerGateway = process.env.TELEGRAM_CUSTOMER_GATEWAY_URL;
  const staffGateway = process.env.TELEGRAM_STAFF_GATEWAY_URL;
  const direct = () => 'https://api.telegram.org/bot' + token + '/' + method;
  if (!customerGateway && !staffGateway) return direct();

  const customer = token === customerBotToken();
  const staff = token === staffBotToken();
  // A shared legacy token cannot identify a bot when either gateway is enabled.
  if (customer === staff) return null;
  const gateway = customer ? customerGateway : staffGateway;
  if (!gateway) return direct();
  try {
    // This transport uses a local SSH tunnel, never a public proxy or URL with credentials.
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/.test(gateway.trim())) return null;
    const url = new URL(gateway.trim());
    if (!url.port || Number(url.port) < 1) return null;
    return url.origin + '/v1/' + (customer ? 'customer' : 'staff') + '/' + method;
  } catch { return null; }
}

// No provider response, URL or credential escapes this boundary.
async function request(
  token: string,
  method: BotMethod,
  payload: object,
  timeout: number,
): Promise<{ ok: boolean; result?: unknown; failure?: Exclude<DeliveryStatus, 'sent'>; retryAfter?: number; unchanged?: boolean; uneditable?: boolean; confirmed?: boolean }> {
  if (!token) return { ok: false, failure: 'rejected' };
  const url = destination(token, method);
  if (!url) return { ok: false, failure: 'rejected' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      if (response.status === 429) {
        // A definite rejection remains retryable even if its optional JSON body is malformed.
        const body: unknown = await response.json().catch(() => null);
        return { ok: false, failure: 'retryable', retryAfter: retryAfter(body) };
      }
      if (response.status === 400 || response.status === 404) {
        const body: unknown = await response.json().catch(() => null);
        const edit = editState(method, body);
        if (edit === 'unchanged') return { ok: true, unchanged: true };
        return { ok: false, failure: 'rejected', confirmed: confirmedRejection(body), ...(edit === 'uneditable' ? { uneditable: true } : {}) };
      }
      await response.body?.cancel();
      return { ok: false, failure: response.status === 403 ? 'blocked' :
        response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown' };
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) {
      const code = body && typeof body === 'object' && 'error_code' in body ? body.error_code : null;
      if (code === 429) return { ok: false, failure: 'retryable', retryAfter: retryAfter(body) };
      const edit = editState(method, body);
      if (edit === 'unchanged') return { ok: true, unchanged: true };
      if (edit === 'uneditable') return { ok: false, failure: 'rejected', uneditable: true, confirmed: true };
      return { ok: false, failure: code === 403 ? 'blocked' :
        typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500 ? 'rejected' : 'unknown', confirmed: confirmedRejection(body) };
    }
    return { ok: true, result: 'result' in body ? body.result : undefined };
  } catch {
    return { ok: false, failure: 'unknown' };
  }
}

function confirmedRejection(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && 'ok' in body && body.ok === false &&
    'error_code' in body && [400, 404].includes(Number(body.error_code)) &&
    'description' in body && typeof body.description === 'string');
}
export type BotOutcome =
  | { status: 'sent'; messageId: number; rich?: true }
  | { status: 'unchanged' }
  | { status: 'rejected'; confirmed?: boolean; uneditable?: boolean }
  | { status: 'blocked' | 'unknown' | 'retryable' };
export async function botExchange(token: string, method: 'sendMessage' | 'sendRichMessage' | 'editMessageText', payload: object): Promise<BotOutcome> {
  const result = await request(token, method, payload, 7000);
  if (result.unchanged) return { status: 'unchanged' };
  if (result.ok) {
    const messageId = sentMessageId(result.result);
    const rich = result.result && typeof result.result === 'object' && 'rich_message' in result.result && result.result.rich_message;
    return messageId ? { status: 'sent', messageId, ...(rich ? { rich: true as const } : {}) } : { status: 'unknown' };
  }
  return result.failure === 'rejected' ? { status: 'rejected', confirmed: result.confirmed, uneditable: result.uneditable }
    : { status: result.failure ?? 'unknown' };
}

function sentMessageId(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('message_id' in result)) return null;
  const id = result.message_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function botDelivery(token: string, payload: object): Promise<BotDelivery> {
  const response = await request(token, 'sendMessage', payload, 7000);
  if (response.failure === 'retryable' && response.retryAfter)
    return { status: 'retryable', retryAfter: response.retryAfter };
  // ok:true without the sent Message is an unknown outcome, never proof of delivery.
  return response.ok ? sentMessageId(response.result) ? 'sent' : 'unknown' : response.failure ?? 'unknown';
}

export async function botMessage(
  token: string,
  method: 'sendMessage' | 'editMessageText',
  payload: object,
  timeout = 7000,
): Promise<boolean> {
  const response = await request(token, method, payload, timeout);
  if (response.unchanged) return true;
  if (response.uneditable && method === 'editMessageText' && 'chat_id' in payload && 'text' in payload) {
    const { message_id: _messageId, inline_message_id: _inlineId, ...message } = payload as Record<string, unknown>;
    const sent = await request(token, 'sendMessage', message, timeout);
    return sent.ok && sentMessageId(sent.result) !== null;
  }
  return response.ok && sentMessageId(response.result) !== null;
}

export async function botRequest(
  token: string,
  method: BotMethod,
  payload: object,
  timeout = 7000,
): Promise<boolean> {
  return (await request(token, method, payload, timeout)).ok;
}

export async function botSendMessageId(token: string, payload: object): Promise<number | null> {
  const response = await request(token, 'sendMessage', payload, 7000);
  return response.ok ? sentMessageId(response.result) : null;
}
