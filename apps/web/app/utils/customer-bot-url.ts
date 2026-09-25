export function customerBotUrl(value: unknown): string | null {
  if (typeof value !== 'string' ||
    !/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$/.test(value)) return null;
  if (/^https:\/\/t\.me\/korzinamarket_seller_bot\/?$/i.test(value)) return null;
  return value;
}
