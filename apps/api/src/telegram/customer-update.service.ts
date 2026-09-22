import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { OrderStatus } from '../db/gen/client.js';
import { botRequest } from './bot-api.js';
import { customerBotToken } from './bot-config.js';
import { customerAction, customerUpdate } from './customer-callback.js';

type Button = { text: string; callback_data: string } | { text: string; url: string };
type Keyboard = { inline_keyboard: Button[][] };
type Identity = { userId: number; firstName: string | null; user: { name: string | null } };
type OrderView = {
  publicId: string; status: OrderStatus; total: number | null; finalTotal: number | null;
  createdAt: Date;
};

const statusText: Record<OrderStatus, string> = {
  NEW: 'Новый', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Собирается',
  READY: 'Готов', DELIVERING: 'Доставляется', COMPLETED: 'Завершён',
  CANCELED: 'Отменён',
};
const activeStatuses: OrderStatus[] = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'];
const amount = (cents: number | null) =>
  cents === null ? 'уточняется' : new Intl.NumberFormat('ru-RU', {
    style: 'currency', currency: 'RUB', maximumFractionDigits: 2,
  }).format(cents / 100);
const date = (value: Date) => new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow',
}).format(value);

@Injectable()
export class CustomerUpdateService {
  private readonly logger = new Logger(CustomerUpdateService.name);
  private readonly token = customerBotToken();

  constructor(private readonly db: DbService) {}

  private siteUrl(path: string): string | undefined {
    try {
      const origin = new URL(process.env.ORDER_SITE_URL ?? '');
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
        return undefined;
      return new URL(path, origin).href;
    } catch {
      return undefined;
    }
  }

  private menu(): Keyboard {
    const rows: Button[][] = [
      [{ text: 'Мои заказы', callback_data: 'orders' }],
      [{ text: 'Текущий заказ', callback_data: 'current' }],
    ];
    const links: Button[] = [];
    const profile = this.siteUrl('/profile');
    const store = this.siteUrl('/');
    if (profile) links.push({ text: 'Профиль', url: profile });
    if (store) links.push({ text: 'Магазин', url: store });
    if (links.length) rows.push(links);
    return { inline_keyboard: rows };
  }

  private async send(chatId: number, text: string, keyboard?: Keyboard): Promise<void> {
    const ok = await botRequest(this.token, 'sendMessage', {
      chat_id: chatId, text,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (!ok) this.logger.warn('Customer Telegram send failed');
  }

  private async answer(id: string, text: string): Promise<void> {
    const ok = await botRequest(this.token, 'answerCallbackQuery',
      { callback_query_id: id, text, cache_time: 0 }, 3000);
    if (!ok) this.logger.warn('Customer Telegram callback answer failed');
  }

  private async identity(telegramUserId: number): Promise<Identity | null> {
    return this.db.telegramIdentity.findUnique({
      where: { telegramUserId: BigInt(telegramUserId) },
      select: { userId: true, firstName: true, user: { select: { name: true } } },
    });
  }

  private orderLine(order: OrderView): string {
    return '#' + order.publicId.slice(0, 8) + ' · ' + statusText[order.status] +
      ' · ' + amount(order.finalTotal ?? order.total) + ' · ' + date(order.createdAt);
  }

  private async orders(chatId: number, userId: number): Promise<void> {
    const orders = await this.db.order.findMany({
      where: { userId }, orderBy: { createdAt: 'desc' }, take: 5,
      select: { publicId: true, status: true, total: true, finalTotal: true, createdAt: true },
    });
    if (!orders.length) {
      await this.send(chatId, 'У вас пока нет заказов.', this.menu());
      return;
    }
    const rows: Button[][] = orders.map(order => {
      const row: Button[] = [{
        text: 'Заказ #' + order.publicId.slice(0, 8),
        callback_data: 'order:' + order.publicId,
      }];
      const url = this.siteUrl('/order/' + order.publicId);
      if (url) row.push({ text: 'Открыть заказ', url });
      return row;
    });
    rows.push([{ text: 'Меню', callback_data: 'menu' }]);
    await this.send(chatId, 'Последние заказы:\n' + orders.map(order => this.orderLine(order)).join('\n'),
      { inline_keyboard: rows });
  }

  private async order(chatId: number, userId: number, publicId?: string): Promise<boolean> {
    const where = publicId ? { userId, publicId } : { userId, status: { in: activeStatuses } };
    const order = await this.db.order.findFirst({
      where, orderBy: { createdAt: 'desc' },
      select: { publicId: true, status: true, total: true, finalTotal: true, createdAt: true },
    });
    if (!order) return false;
    const rows: Button[][] = [];
    const url = this.siteUrl('/order/' + order.publicId);
    if (url) rows.push([{ text: 'Открыть заказ', url }]);
    rows.push([{ text: 'Мои заказы', callback_data: 'orders' }]);
    await this.send(chatId, 'Заказ ' + this.orderLine(order), { inline_keyboard: rows });
    return true;
  }

  async handle(body: unknown): Promise<void> {
    const parsed = customerUpdate.safeParse(body);
    if (!parsed.success) return;
    const { message, callback_query: callback } = parsed.data;
    const actor = callback?.from ?? message?.from;
    const chat = callback?.message?.chat ?? message?.chat;
    // Customer operations are private-chat only, bound to the verified update sender.
    if (!actor || !chat || chat.type !== 'private' || chat.id !== actor.id) return;
    const action = callback ? customerAction(callback.data) :
      message?.text?.split(' ')[0];
    if (!action || (typeof action === 'string' &&
      !['/start', '/menu', '/orders', 'menu', 'orders', 'current'].includes(action))) {
      if (callback) await this.answer(callback.id, 'Некорректная кнопка');
      return;
    }
    let ack = 'Готово';
    try {
      const identity = await this.identity(actor.id);
      if (!identity) {
        const store = this.siteUrl('/');
        await this.send(chat.id,
          'Чтобы пользоваться ботом, войдите через Telegram на сайте KorzinaMarket.',
          store ? { inline_keyboard: [[{ text: 'Открыть магазин', url: store }]] } : undefined);
        ack = 'Сначала войдите через Telegram на сайте';
      } else if (action === '/start') {
        await this.db.telegramIdentity.update({
          where: { telegramUserId: BigInt(actor.id) },
          data: { customerBotStartedAt: new Date(), customerBotBlockedAt: null },
        });
        const name = (identity.user.name || identity.firstName || 'покупатель').slice(0, 80);
        await this.send(chat.id, 'Привет, ' + name + '!\nВы вошли в KorzinaMarket через Telegram.', this.menu());
      } else if (action === '/menu' || action === 'menu') {
        const name = (identity.user.name || identity.firstName || 'покупатель').slice(0, 80);
        await this.send(chat.id, 'Привет, ' + name + '!\nВы вошли в KorzinaMarket через Telegram.', this.menu());
      } else if (action === '/orders' || action === 'orders') {
        await this.orders(chat.id, identity.userId);
      } else if (action === 'current') {
        if (!await this.order(chat.id, identity.userId)) {
          await this.send(chat.id, 'Текущих заказов нет.', this.menu());
        }
      } else if (typeof action === 'object') {
        if (!await this.order(chat.id, identity.userId, action.publicId)) {
          ack = 'Заказ недоступен';
        }
      }
    } catch {
      this.logger.error('Customer Telegram update failed');
      ack = 'Не удалось выполнить действие';
    } finally {
      if (callback) await this.answer(callback.id, ack);
    }
  }
}
