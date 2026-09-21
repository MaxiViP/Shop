import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { OrderStatus } from '../db/gen/client.js';
import { newOrderMessage, telegramOrderSelect } from './message.js';
import { orderKeyboard, type OrderCallback } from './callback.js';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token = process.env.TELEGRAM_BOT_TOKEN?.trim();
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
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    return this.available && secret.length > 0 && secret.length <= 256 && !/[^A-Za-z0-9_-]/.test(secret);
  }

  canManage(callback: OrderCallback): boolean {
    const { from, message } = callback;
    return this.callbacksAvailable && this.chatIds.includes(String(from.id)) &&
      this.chatIds.includes(String(message.chat.id)) &&
      (message.chat.type !== 'private' || message.chat.id === from.id);
  }

  // This boundary never rejects. The caller can dispatch without awaiting Telegram.
  async notifyNewOrder(orderId: number): Promise<void> {
    if (!this.available) return;
    try {
      const order = await this.db.order.findUnique({
        where: { id: orderId }, select: telegramOrderSelect,
      });
      if (!order) return;
      const text = newOrderMessage(order);
      const keyboard = orderKeyboard(orderId, order.status, this.orderUrl(orderId), this.callbacksAvailable);
      await Promise.all(this.chatIds.map(chatId => this.request('sendMessage', {
        chat_id: chatId, text,
        link_preview_options: { is_disabled: true },
        ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
      }, 'Telegram notification failed for order ' + orderId)));
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
    method: 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup',
    payload: object,
    failure: string,
    timeout = 7000,
  ): Promise<void> {
    if (!this.token) return;
    try {
      const response = await fetch('https://api.telegram.org/bot' + this.token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('TELEGRAM_REQUEST_FAILED');
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true)
        throw new Error('TELEGRAM_REQUEST_FAILED');
    } catch {
      // Never log errors, provider responses, chat IDs, credentials or request URLs.
      this.logger.warn(failure);
    }
  }
}
