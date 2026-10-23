import { Logger } from '@nestjs/common';
import type { InputRichBlock } from './rich.js';
import type { BotKind } from './rich-policy.js';
import { createHash } from 'node:crypto';
import { customerBotToken, staffBotToken } from './bot-config.js';

const logger = new Logger('TelegramMedia');
const cache = new Map<string, { fileId: string; at: number }>();
const key = (bot: BotKind, url: string, thumbnail: boolean) => createHash('sha256').update(bot === 'customer' ? customerBotToken() : staffBotToken()).digest('hex') + ':' + thumbnail + ':' + url;
type PhotoBlock = Extract<InputRichBlock, { type: 'photo' }>;
export function mapPhotos(blocks: InputRichBlock[], map: (photo: PhotoBlock, thumbnail: boolean) => PhotoBlock, thumbnail = false): InputRichBlock[] {
  return blocks.map(block => block.type === 'photo' ? map(block, thumbnail)
    : block.type === 'collage' || block.type === 'details' ? { ...block, blocks: mapPhotos(block.blocks, map, thumbnail || block.type === 'collage') } : block);
}
export function withoutPhotos(blocks: InputRichBlock[]): InputRichBlock[] {
  return blocks.filter(block => block.type !== 'photo' && block.type !== 'collage')
    .map(block => block.type === 'details' ? { ...block, blocks: withoutPhotos(block.blocks) } : block);
}
export function mediaDiagnostic(reason: 'no_image' | 'invalid_url' | 'media_rejected' | 'fallback_used') {
  // Fixed reason codes only: never URLs, identifiers, provider responses or credentials.
  logger.debug(reason);
}
export function reusePhotos(bot: BotKind, blocks: InputRichBlock[]): InputRichBlock[] {
  return mapPhotos(blocks, (block, thumbnail) => {
    const known = cache.get(key(bot, block.photo.media, thumbnail));
    return known && Date.now() - known.at < 15 * 60_000
      ? { ...block, photo: { ...block.photo, media: known.fileId } } : block;
  });
}
export function rememberPhotos(bot: BotKind, blocks: InputRichBlock[], fileIds: string[]) {
  const photos: { block: PhotoBlock; thumbnail: boolean }[] = [];
  mapPhotos(blocks, (block, thumbnail) => { photos.push({ block, thumbnail }); return block; });
  if (photos.length !== fileIds.length) return;
  photos.forEach(({ block, thumbnail }, index) => cache.set(key(bot, block.photo.media, thumbnail), { fileId: fileIds[index]!, at: Date.now() }));
  while (cache.size > 256) cache.delete(cache.keys().next().value!);
}
