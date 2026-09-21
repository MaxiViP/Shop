import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { newOrderMessage, telegramOrderSelect } from './message.js';

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

  // This boundary never rejects. The caller can dispatch without awaiting Telegram.
  async notifyNewOrder(orderId: number): Promise<void> {
    if (!this.available) return;
    try {
      const order = await this.db.order.findUnique({
        where: { id: orderId }, select: telegramOrderSelect,
      });
      if (!order) return;
      const text = newOrderMessage(order);
      const url = this.orderUrl(orderId);
      await Promise.all(this.chatIds.map(chatId => this.send(orderId, chatId, text, url)));
    } catch {
      // Never log caught errors, provider responses, request URLs or customer data.
      this.logger.warn('Telegram notification failed for order ' + orderId);
    }
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

  private async send(orderId: number, chatId: string, text: string, url?: string): Promise<void> {
    try {
      const response = await fetch('https://api.telegram.org/bot' + this.token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(7000),
        body: JSON.stringify({
          chat_id: chatId, text,
          link_preview_options: { is_disabled: true },
          ...(url ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть заказ', url }]] } } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('TELEGRAM_SEND_FAILED');
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true)
        throw new Error('TELEGRAM_SEND_FAILED');
    } catch {
      // Each recipient is isolated; do not include chat IDs or error contents.
      this.logger.warn('Telegram notification failed for order ' + orderId);
    }
  }
}
