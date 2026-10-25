import { botExchange, type BotOutcome } from './bot-api.js';
import { customerBotToken, staffBotToken } from './bot-config.js';
import { richEnabled, type BotKind } from './rich-policy.js';
import { fallbackHtml, richMessage, validScreen, type TelegramScreen } from './rich.js';
import { mapPhotos, withoutPhotos, mediaDiagnostic, rememberPhotos, reusePhotos } from './media.js';
import { localPhoto } from './photo.js';
import { catalogImage, isCatalogPhoto } from './catalog-photo.js';

export type ScreenTarget = { chatId: number; messageId?: number };
export async function deliverScreen(bot: BotKind, target: ScreenTarget, screen: TelegramScreen): Promise<BotOutcome> {
  if (!validScreen(screen)) return { status: 'rejected' };
  if (screen.mediaReason) mediaDiagnostic(screen.mediaReason);
  const token = bot === 'customer' ? customerBotToken() : staffBotToken();
  const common = { chat_id: target.chatId, ...(target.messageId ? { message_id: target.messageId } : {}) };
  const edit = Boolean(target.messageId);
  const plain = () => botExchange(token, edit ? 'editMessageText' : 'sendMessage', {
    ...common, text: fallbackHtml(screen.text, screen.fallback), parse_mode: 'HTML', reply_markup: screen.keyboard,
    link_preview_options: { is_disabled: true },
  });
  let result: BotOutcome;
  if (await richEnabled(bot, target.chatId)) {
    const rich = richMessage(screen);
    const original = rich.blocks;
    const mediaFallback = () => screen.mediaFallback ? richMessage({ ...screen, rich: { blocks: screen.mediaFallback } }).blocks : withoutPhotos(rich.blocks);
    rich.blocks = reusePhotos(bot, original, screen.thumbnailPhotos);
    const send = async () => {
      const uploads = new Map<string, Uint8Array>();
      const sources: { media: string; thumbnail: boolean }[] = [];
      mapPhotos(rich.blocks, (block, thumbnail) => { sources.push({ media: block.photo.media, thumbnail }); return block; }, screen.thumbnailPhotos);
      let missingGalleryPhoto = false;
      // Bounded page (8 images), sequential local preparation; never fetch a remote gallery URL.
      for (const source of sources) {
        const photo = isCatalogPhoto(source.media) ? (await catalogImage(source.media))?.bytes : await localPhoto(source.media, undefined, source.thumbnail);
        if (photo) uploads.set(source.thumbnail + ':' + source.media, photo);
        else if (isCatalogPhoto(source.media) || source.thumbnail && /^https?:/.test(source.media)) missingGalleryPhoto = true;
      }
      if (missingGalleryPhoto) { rich.blocks = mediaFallback(); uploads.clear(); mediaDiagnostic('fallback_used'); }
      const files = new Map<string, Uint8Array>();
      const blocks = mapPhotos(rich.blocks, (block, thumbnail) => {
        const photo = uploads.get(thumbnail + ':' + block.photo.media);
        if (!photo) return block;
        const name = files.size ? 'photo' + files.size : 'photo';
        files.set(name, photo);
        return { ...block, photo: { type: 'photo', media: 'attach://' + name } };
      }, screen.thumbnailPhotos);
      return botExchange(token, edit ? 'editMessageText' : 'sendRichMessage', { ...common, rich_message: { ...rich, blocks } }, files.size ? files : undefined);
    };
    result = await send();
    // Only a confirmed Telegram rejection permits a different representation.
    if (result.status === 'rejected' && result.confirmed && !result.uneditable) {
      if (JSON.stringify(withoutPhotos(rich.blocks)) !== JSON.stringify(rich.blocks)) {
        mediaDiagnostic('media_rejected');
        if (JSON.stringify(rich.blocks) !== JSON.stringify(original)) {
          rich.blocks = original;
          result = await send();
        }
        if (result.status === 'rejected' && result.confirmed && !result.uneditable) {
          mediaDiagnostic('fallback_used');
          rich.blocks = mediaFallback();
          result = await send();
        }
      }
      if (result.status === 'rejected' && result.confirmed && !result.uneditable) { mediaDiagnostic('fallback_used'); result = await plain(); }
    }
    if (result.status === 'sent' && result.photoFileIds) rememberPhotos(bot, original, result.photoFileIds, screen.thumbnailPhotos);
  } else result = await plain();
  if (result.status === 'rejected' && result.uneditable && target.messageId) {
    // Definite missing/uneditable message, not timeout. Return and bind the new ID.
    return deliverScreen(bot, { chatId: target.chatId }, screen);
  }
  return result;
}
