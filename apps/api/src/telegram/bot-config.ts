export const customerBotToken = () =>
  (process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();

export const staffBotToken = () =>
  (process.env.TELEGRAM_STAFF_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();

export const staffWebhookSecret = () =>
  process.env.TELEGRAM_STAFF_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || '';

export const customerWebhookSecret = () =>
  process.env.TELEGRAM_CUSTOMER_WEBHOOK_SECRET || '';

export const validWebhookSecret = (value: string) =>
  value.length > 0 && value.length <= 256 && !/[^A-Za-z0-9_-]/.test(value);

export function staffPageUrl(path: string): string | undefined {
  try {
    const origin = new URL(process.env.ORDER_SITE_URL ?? '');
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
      !path.startsWith('/') || path.startsWith('//'))
      return undefined;
    const url = new URL(path, origin);
    return url.origin === origin.origin ? url.href : undefined;
  } catch { return undefined; }
}

// Telegram permits one webhook per bot token. The legacy single-bot deployment
// keeps staff callbacks working; customer updates are enabled only after split.
export const customerWebhookReady = () =>
  Boolean(customerBotToken() && staffBotToken() && customerBotToken() !== staffBotToken()) &&
  validWebhookSecret(customerWebhookSecret()) &&
  validWebhookSecret(staffWebhookSecret()) &&
  customerWebhookSecret() !== staffWebhookSecret();
