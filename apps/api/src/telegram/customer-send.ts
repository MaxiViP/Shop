import { Logger } from '@nestjs/common';
import { botSendMessageId } from './bot-api.js';
import { deliverScreen } from './delivery.js';
import { customerBotToken } from './bot-config.js';
import type { Screen } from './customer-view.js';
export type CustomerTarget = { chatId: number; messageId?: number };
export type CustomerIdentity = { id: number; userId: number };
const logger = new Logger('CustomerTelegram');
export async function customerShow(target: CustomerTarget, screen: Screen) {
  const result = await deliverScreen('customer', target, screen);
  if (result.status === 'sent') target.messageId = result.messageId;
  const ok = result.status === 'sent' || result.status === 'unchanged';
  if (!ok) logger.warn('Customer Telegram display failed');
  return ok;
}
export function customerPrompt(chatId: number, text: string) {
  return botSendMessageId(customerBotToken(), {
    chat_id: chatId,
    text,
    reply_markup: { force_reply: true, inline_keyboard: [[{ text: 'Отменить ввод', callback_data: 'cancel' }, { text: 'Меню', callback_data: 'menu' }]] },
  });
}
