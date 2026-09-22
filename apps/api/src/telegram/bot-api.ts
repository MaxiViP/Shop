export type BotMethod = 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup';

// No provider response, URL or credential escapes this boundary.
export async function botRequest(
  token: string,
  method: BotMethod,
  payload: object,
  timeout = 7000,
): Promise<boolean> {
  if (!token) return false;
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
      return false;
    }
    const body: unknown = await response.json();
    return Boolean(body && typeof body === 'object' && 'ok' in body && body.ok === true);
  } catch {
    return false;
  }
}
