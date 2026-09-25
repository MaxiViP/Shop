import { customerBotToken, staffBotToken } from './bot-config.js';

const methods = ['sendMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'] as const;
export type BotMethod = typeof methods[number];

export type BotDelivery = 'sent' | 'rejected' | 'blocked' | 'unknown';

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
): Promise<{ ok: boolean; result?: unknown; failure?: Exclude<BotDelivery, 'sent'> }> {
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
      await response.body?.cancel();
      return { ok: false, failure: response.status === 403 ? 'blocked' :
        response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown' };
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) {
      const code = body && typeof body === 'object' && 'error_code' in body ? body.error_code : null;
      return { ok: false, failure: code === 403 ? 'blocked' :
        typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500 ? 'rejected' : 'unknown' };
    }
    return { ok: true, result: 'result' in body ? body.result : undefined };
  } catch {
    return { ok: false, failure: 'unknown' };
  }
}

function sentMessageId(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('message_id' in result)) return null;
  const id = result.message_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function botDelivery(token: string, payload: object): Promise<BotDelivery> {
  const response = await request(token, 'sendMessage', payload, 7000);
  // ok:true without the sent Message is an unknown outcome, never proof of delivery.
  return response.ok ? sentMessageId(response.result) ? 'sent' : 'unknown' : response.failure ?? 'unknown';
}

export async function botMessage(
  token: string,
  method: 'sendMessage' | 'editMessageText',
  payload: object,
): Promise<boolean> {
  const response = await request(token, method, payload, 7000);
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
