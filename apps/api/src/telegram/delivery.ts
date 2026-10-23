import { botExchange, type BotOutcome } from './bot-api.js';
import { customerBotToken, staffBotToken } from './bot-config.js';
import { richEnabled, type BotKind } from './rich-policy.js';
import { fallbackHtml, richMessage, validScreen, type TelegramScreen } from './rich.js';
import { mediaDiagnostic, rememberPhotos, reusePhotos } from './media.js';
import { localPhoto } from './photo.js';

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
    rich.blocks = reusePhotos(bot, original);
    const send = async () => {
      const block = rich.blocks.find(block => block.type === 'photo');
      const photo = block?.type === 'photo' ? await localPhoto(block.photo.media) : undefined;
      const message = photo ? { ...rich, blocks: rich.blocks.map(value => value === block ? { ...block, photo: { type: 'photo' as const, media: 'attach://photo' } } : value) } : rich;
      return botExchange(token, edit ? 'editMessageText' : 'sendRichMessage', { ...common, rich_message: message }, photo);
    };
    result = await send();
    // Only a confirmed Telegram rejection permits a different representation.
    if (result.status === 'rejected' && result.confirmed && !result.uneditable) {
      if (rich.blocks.some(block => block.type === 'photo')) {
        mediaDiagnostic('media_rejected');
        if (JSON.stringify(rich.blocks) !== JSON.stringify(original)) {
          rich.blocks = original;
          result = await send();
        }
        if (result.status === 'rejected' && result.confirmed && !result.uneditable) {
          mediaDiagnostic('fallback_used');
          rich.blocks = rich.blocks.filter(block => block.type !== 'photo');
          result = await send();
        }
      }
      if (result.status === 'rejected' && result.confirmed && !result.uneditable) { mediaDiagnostic('fallback_used'); result = await plain(); }
    }
    if (result.status === 'sent' && result.photoFileIds) rememberPhotos(bot, original, result.photoFileIds);
  } else result = await plain();
  if (result.status === 'rejected' && result.uneditable && target.messageId) {
    // Definite missing/uneditable message, not timeout. Return and bind the new ID.
    return deliverScreen(bot, { chatId: target.chatId }, screen);
  }
  return result;
}
