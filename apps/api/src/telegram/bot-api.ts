export type BotMethod = 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup' | 'editMessageText';

export type BotDelivery = 'sent' | 'rejected' | 'blocked' | 'unknown';

// No provider response, URL or credential escapes this boundary.
async function request(
  token: string,
  method: BotMethod,
  payload: object,
  timeout: number,
): Promise<{ ok: boolean; result?: unknown; failure?: Exclude<BotDelivery, 'sent'> }> {
  if (!token) return { ok: false, failure: 'rejected' };
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
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
