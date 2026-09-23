export type BotMethod = 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup' | 'editMessageText';

// No provider response, URL or credential escapes this boundary.
async function request(
  token: string,
  method: BotMethod,
  payload: object,
  timeout: number,
): Promise<{ ok: boolean; result?: unknown }> {
  if (!token) return { ok: false };
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
      return { ok: false };
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true)
      return { ok: false };
    return { ok: true, result: 'result' in body ? body.result : undefined };
  } catch {
    return { ok: false };
  }
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
  const result = response.result;
  if (!response.ok || !result || typeof result !== 'object' || !('message_id' in result))
    return null;
  const id = result.message_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}
