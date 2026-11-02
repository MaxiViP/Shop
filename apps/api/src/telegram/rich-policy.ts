import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const chats = z.array(z.string().regex(/^[1-9]\d{0,15}$/)).max(1000).default([]);
const policy = z.object({ enabled: z.boolean(), customer: chats, staff: chats,
  global: z.object({ customer: z.boolean().default(false), staff: z.boolean().default(false) }).strict().optional(),
  customerGalleryTables: chats.optional(),
}).strict();
export type BotKind = 'customer' | 'staff';

// Read on every screen: an atomic config-file replacement disables Rich without a restart.
// Fail closed; never log file contents or chat identifiers.
export async function richEnabled(bot: BotKind, chatId: number): Promise<boolean> {
  const config = await readPolicy(chatId);
  return Boolean(config?.enabled && (config.global?.[bot] === true || config[bot].includes(String(chatId))));
}

// Table callbacks have known iOS client issues. Never inherit global Rich activation.
export async function galleryTablesEnabled(chatId: number): Promise<boolean> {
  const config = await readPolicy(chatId);
  return Boolean(config?.enabled && config.customerGalleryTables?.includes(String(chatId)) &&
    (config.global?.customer === true || config.customer.includes(String(chatId))));
}

async function readPolicy(chatId: number) {
  const file = process.env.TELEGRAM_RICH_CONFIG_FILE;
  if (!file || !Number.isSafeInteger(chatId) || chatId < 1) return;
  try {
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 32 * 1024) return;
    const result = policy.safeParse(JSON.parse(text));
    // Presentation only: handler authorization and STAFF access checks remain mandatory.
    return result.success ? result.data : undefined;
  } catch { return; }
}
