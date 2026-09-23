import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { OrderStatus } from '../db/gen/client.js';
import { newOrderMessage, telegramOrderSelect } from './message.js';
import { orderKeyboard } from './callback.js';
import { botRequest, botSendMessageId, type BotMethod } from './bot-api.js';
import { staffBotToken, staffWebhookSecret, validWebhookSecret } from './bot-config.js';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token = staffBotToken();
  private readonly chatIds = [...new Set(
    (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '').split(',')
      .map(value => value.trim())
      .filter(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) !== 0)
      .map(value => String(Number(value))),
  )];

  constructor(private readonly db: DbService) {}

  get available(): boolean {
    return Boolean(this.token && this.chatIds.length);
  }

  private get callbacksAvailable(): boolean {
    return this.available && validWebhookSecret(staffWebhookSecret());
  }

  canManagePrivate(userId: number, chatId: number): boolean {
    return this.callbacksAvailable && userId === chatId && this.chatIds.includes(String(userId));
  }

  async sendStaff(chatId: number, text: string, replyMarkup?: object): Promise<void> {
    await this.request('sendMessage', {
      chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, 'Telegram staff send failed');
  }

  async promptStaff(chatId: number, text: string): Promise<number | null> {
    if (!this.token) return null;
    const id = await botSendMessageId(this.token, {
      chat_id: chatId, text, reply_markup: { force_reply: true, selective: true },
    });
    if (!id) this.logger.warn('Telegram staff prompt failed');
    return id;
  }

  async editStaff(chatId: number, messageId: number, text: string, replyMarkup: object): Promise<void> {
    await this.request('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      reply_markup: replyMarkup,
      link_preview_options: { is_disabled: true },
    }, 'Telegram staff dashboard update failed', 3000);
  }

  staffOrderUrl(orderId: number): string | undefined { return this.orderUrl(orderId); }

  // This boundary never rejects. The caller can dispatch without awaiting Telegram.
  async notifyNewOrder(orderId: number): Promise<void> {
    if (!this.available) return;
    try {
      const order = await this.db.order.findUnique({
        where: { id: orderId }, select: telegramOrderSelect,
      });
      if (!order) return;
      const text = newOrderMessage(order);
      await Promise.all(this.chatIds.map(chatId => {
        // Group recipients keep read-only notifications; seller actions require private chat.
        const keyboard = orderKeyboard(orderId, order.status, this.orderUrl(orderId),
          this.callbacksAvailable && Number(chatId) > 0);
        return this.request('sendMessage', {
          chat_id: chatId, text,
          link_preview_options: { is_disabled: true },
          ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
        }, 'Telegram notification failed for order ' + orderId);
      }));
    } catch {
      this.logger.warn('Telegram notification failed for order ' + orderId);
    }
  }

  async answerCallbackQuery(id: string, text: string): Promise<void> {
    await this.request('answerCallbackQuery', { callback_query_id: id, text, cache_time: 0 },
      'Telegram callback answer failed', 3000);
  }

  async editOrderKeyboard(chatId: number, messageId: number, orderId: number, status: OrderStatus): Promise<void> {
    await this.request('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId,
      reply_markup: orderKeyboard(orderId, status, this.orderUrl(orderId), this.callbacksAvailable),
    }, 'Telegram keyboard update failed for order ' + orderId, 3000);
  }

  private orderUrl(orderId: number): string | undefined {
    try {
      const origin = new URL(process.env.ORDER_SITE_URL ?? '');
      if (origin.protocol !== 'https:' || origin.username || origin.password)
        throw new Error('CONFIG');
      return new URL('/staff/orders/' + orderId, origin).href;
    } catch {
      this.logger.warn('Telegram staff link unavailable: check ORDER_SITE_URL');
      return undefined;
    }
  }

  private async request(
    method: BotMethod,
    payload: object,
    failure: string,
    timeout = 7000,
  ): Promise<void> {
    if (this.token && !await botRequest(this.token, method, payload, timeout))
      this.logger.warn(failure);
  }
}
