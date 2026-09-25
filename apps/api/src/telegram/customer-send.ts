import { Logger } from '@nestjs/common';
import { botMessage, botSendMessageId } from './bot-api.js';
import { customerBotToken } from './bot-config.js';
import type { Screen } from './customer-view.js';
export type CustomerTarget = { chatId: number; messageId?: number };
export type CustomerIdentity = { id: number; userId: number };
const logger = new Logger('CustomerTelegram');
export async function customerShow(target: CustomerTarget, screen: Screen) {
  const ok = await botMessage(
    customerBotToken(),
    target.messageId ? 'editMessageText' : 'sendMessage',
    {
      chat_id: target.chatId,
      ...(target.messageId ? { message_id: target.messageId } : {}),
      text: screen.text,
      reply_markup: screen.keyboard,
      link_preview_options: { is_disabled: true },
    },
  );
  if (!ok) logger.warn('Customer Telegram display failed');
  return ok;
}
export function customerPrompt(chatId: number, text: string) {
  return botSendMessageId(customerBotToken(), {
    chat_id: chatId,
    text,
    reply_markup: { force_reply: true, selective: true },
  });
}
