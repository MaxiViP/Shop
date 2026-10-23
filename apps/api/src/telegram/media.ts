import { Logger } from '@nestjs/common';
import type { InputRichBlock } from './rich.js';
import type { BotKind } from './rich-policy.js';
import { createHash } from 'node:crypto';
import { customerBotToken, staffBotToken } from './bot-config.js';

const logger = new Logger('TelegramMedia');
const cache = new Map<string, { fileId: string; at: number }>();
const key = (bot: BotKind, url: string) => createHash('sha256').update(bot === 'customer' ? customerBotToken() : staffBotToken()).digest('hex') + ':' + url;
export function mediaDiagnostic(reason: 'no_image' | 'invalid_url' | 'media_rejected' | 'fallback_used') {
  // Fixed reason codes only: never URLs, identifiers, provider responses or credentials.
  logger.debug(reason);
}
export function reusePhotos(bot: BotKind, blocks: InputRichBlock[]): InputRichBlock[] {
  return blocks.map(block => {
    if (block.type !== 'photo') return block;
    const known = cache.get(key(bot, block.photo.media));
    return known && Date.now() - known.at < 15 * 60_000
      ? { ...block, photo: { ...block.photo, media: known.fileId } } : block;
  });
}
export function rememberPhotos(bot: BotKind, blocks: InputRichBlock[], fileIds: string[]) {
  const photos = blocks.filter(block => block.type === 'photo');
  if (photos.length !== fileIds.length) return;
  photos.forEach((block, index) => cache.set(key(bot, block.photo.media), { fileId: fileIds[index]!, at: Date.now() }));
  while (cache.size > 256) cache.delete(cache.keys().next().value!);
}
