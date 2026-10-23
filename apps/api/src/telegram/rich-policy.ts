import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const chats = z.array(z.string().regex(/^[1-9]\d{0,15}$/)).max(1000).default([]);
const policy = z.object({ enabled: z.boolean(), customer: chats, staff: chats }).strict();
export type BotKind = 'customer' | 'staff';

// Read on every screen: an atomic config-file replacement disables Rich without a restart.
// Fail closed; never log file contents or chat identifiers.
export async function richEnabled(bot: BotKind, chatId: number): Promise<boolean> {
  const file = process.env.TELEGRAM_RICH_CONFIG_FILE;
  if (!file || !Number.isSafeInteger(chatId) || chatId < 1) return false;
  try {
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 32 * 1024) return false;
    const result = policy.safeParse(JSON.parse(text));
    return result.success && result.data.enabled && result.data[bot].includes(String(chatId));
  } catch { return false; }
}
