import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service.js';
import { StaffService } from '../staff/staff.service.js';
import { staffActor } from '../staff/audit.js';
import { callbackIdSchema, parseAction } from './callback.js';
import { StaffLinkService } from './staff-link.service.js';
import { StaffBotFlowService } from './staff-bot-flow.service.js';
import { parseStaffAction, staffData, staffUpdate, clean,
  type StaffCallback, type StaffMessage } from './staff-bot.js';
import { activeStatuses, dashboard, extraPage, itemPage, itemView, statusText,
  type Keyboard } from './staff-bot-view.js';
import { TelegramService } from './telegram.service.js';

type Identity = { id: number; userId: number; user: { role: 'USER' | 'SELLER' | 'ADMIN' } };

@Injectable()
export class StaffBotService {
  private readonly logger = new Logger(StaffBotService.name);
  constructor(
    private readonly db: DbService,
    private readonly staff: StaffService,
    private readonly telegram: TelegramService,
    private readonly links: StaffLinkService,
    private readonly flows: StaffBotFlowService,
  ) {}

  async handle(body: unknown): Promise<void> {
    const parsed = staffUpdate.safeParse(body);
    if (!parsed.success) {
      const ack = z.object({ callback_query: callbackIdSchema }).safeParse(body);
      if (ack.success) await this.telegram.answerCallbackQuery(ack.data.callback_query.id,
        'Некорректная кнопка');
      return;
    }
    const { message, callback_query: callback } = parsed.data;
    if (!message && !callback) return;
    const from = callback?.from ?? message?.from;
    const chat = callback?.message.chat ?? message?.chat;
    if (!from || !chat || chat.type !== 'private' || chat.id !== from.id ||
      !this.telegram.canManagePrivate(from.id, chat.id)) {
      if (callback) await this.telegram.answerCallbackQuery(callback.id, 'Нет доступа');
      return;
    }
    let answer = 'Готово';
    try {
      if (message?.text?.startsWith('/link ')) {
        const linked = await this.links.link(from.id, message.text.slice(6).trim());
        await this.telegram.sendStaff(chat.id, linked
          ? 'Аккаунт сотрудника подключён. Отправьте /orders.'
          : 'Код недействителен или устарел. Получите новый код в кабинете сотрудника.');
        return;
      }
      const identity = await this.identity(from.id);
      if (!identity) {
        if (callback) answer = 'Сначала привяжите аккаунт сотрудника';
        else await this.telegram.sendStaff(chat.id,
          'Для работы получите одноразовый код в кабинете сотрудника и отправьте /link КОД.');
        return;
      }
      if (message) await this.message(message, identity);
      else if (callback) answer = await this.callback(callback, identity);
    } catch (error) {
      if (error instanceof HttpException && [400, 403, 404, 409].includes(error.getStatus())) {
        answer = error.getStatus() === 403 ? 'Нет доступа' :
          'Заказ изменился. Обновите его и повторите действие.';
        if (message) await this.telegram.sendStaff(chat.id, answer);
      } else {
        answer = 'Не удалось выполнить действие';
        this.logger.error('Staff Telegram update failed');
        if (message) await this.telegram.sendStaff(chat.id, answer);
        // Let Telegram retry unexpected DB/programming failures; never expose provider details.
        throw new InternalServerErrorException('Staff Telegram update failed');
      }
    } finally {
      if (callback) await this.telegram.answerCallbackQuery(callback.id, answer);
    }
  }

  private async identity(telegramUserId: number): Promise<Identity | null> {
    const identity = await this.db.staffTelegramIdentity.findUnique({
      where: { telegramUserId: BigInt(telegramUserId) },
      select: { id: true, userId: true, user: { select: { role: true } } },
    });
    return identity && ['SELLER', 'ADMIN'].includes(identity.user.role) ? identity : null;
  }

  private async message(message: StaffMessage, identity: Identity): Promise<void> {
    const chatId = message.chat.id;
    const text = message.text?.trim() ?? '';
    if (text === '/cancel') {
      await this.flows.cancel(identity.id);
      await this.telegram.sendStaff(chatId, 'Ввод отменён. Отправьте /orders.');
      return;
    }
    if (text === '/start') {
      await this.db.staffTelegramIdentity.update({
        where: { id: identity.id }, data: { botStartedAt: new Date(), blockedAt: null },
      });
      await this.telegram.sendStaff(chatId, 'KorzinaMarket · кабинет продавца\nОтправьте /orders для списка заказов.');
      return;
    }
    if (text === '/orders') return this.orders(chatId);
    if (/^\/order [1-9]\d{0,9}$/.test(text)) {
      const orderId = Number(text.slice(7));
      if (orderId <= 2147483647) await this.order(chatId, null, orderId);
      return;
    }
    if (text.startsWith('/')) return;
    const result = await this.flows.input(message, identity.id, staffActor({ id: identity.userId, role: identity.user.role }));
    if (result) await this.order(chatId, result.dashboardMessageId, result.orderId);
  }

  private async orders(chatId: number, messageId?: number): Promise<void> {
    const rows = await this.db.order.findMany({
      where: { status: { in: [...activeStatuses] } }, take: 12, orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, customerName: true, type: true },
    });
    const lines = activeStatuses.flatMap(status => {
      const grouped = rows.filter(row => row.status === status);
      return grouped.length ? [statusText[status] + ':', ...grouped.map(row =>
        '#' + row.id + ' · ' + clean(row.customerName, 35) +
        (row.type === 'PICKUP' ? ' · самовывоз' : ' · доставка'))] : [];
    });
    const keyboard: Keyboard = { inline_keyboard: rows.map(row => [{
      text: '#' + row.id + ' · ' + statusText[row.status], callback_data: staffData(row.id, 'o'),
    }]) };
    await this.render(chatId, messageId, lines.length ? 'Активные заказы\n\n' + lines.join('\n') :
      'Активных заказов нет.', keyboard);
  }

  private async order(chatId: number, messageId: number | null, orderId: number): Promise<void> {
    const order = await this.staff.get(orderId);
    const view = dashboard(order, this.telegram.staffOrderUrl(orderId));
    await this.render(chatId, messageId, view.text, view.keyboard);
  }

  private async render(chatId: number, messageId: number | null | undefined, text: string,
    keyboard: Keyboard): Promise<void> {
    if (messageId) await this.telegram.editStaff(chatId, messageId, text.slice(0, 3900), keyboard);
    else await this.telegram.sendStaff(chatId, text.slice(0, 3900), keyboard);
  }

  private async callback(callback: StaffCallback, identity: Identity): Promise<string> {
    const legacy = parseAction(callback.data);
    const parsed = parseStaffAction(callback.data);
    if (!legacy && !parsed) return 'Некорректная кнопка';
    const orderId = (legacy ?? parsed)!.orderId;
    const action = legacy?.action ?? parsed!.action;
    const actor = staffActor({ id: identity.userId, role: identity.user.role });
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (action === 'cancel_back' || action === 'zb') {
      await this.flows.cancel(identity.id, orderId);
      await this.order(chatId, messageId, orderId);
      return 'Ввод отменён';
    }
    if (action === 'cancel_confirm' || action === 'zy' || action === 'xs' || action === 'ds') {
      const kind = action === 'cancel_confirm' || action === 'zy' ? 'CANCEL' :
        action === 'xs' ? 'EXTRA' : 'DELIVERY';
      const done = await this.flows.finish(identity.id, actor, orderId,
        kind, parsed?.code);
      if (!done) return 'Ввод устарел. Откройте заказ заново.';
      await this.order(chatId, messageId, orderId);
      return 'Заказ обновлён';
    }

    const order = await this.staff.get(orderId);
    if (action === 'confirm') {
      if (order.status !== 'NEW') return 'Статус заказа уже изменился';
      await this.staff.confirm(orderId, actor);
    } else if (action === 'assembly') {
      if (order.status !== 'CONFIRMED') return 'Статус заказа уже изменился';
      await this.staff.startAssembly(orderId, actor);
    } else if (action === 'f') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      try {
        await this.staff.finishAssembly(orderId, actor);
      } catch (error) {
        if (!(error instanceof HttpException) || ![400, 409].includes(error.getStatus())) throw error;
        await this.order(chatId, messageId, orderId);
        return 'Сборку нельзя завершить: проверьте позиции и вопросы покупателя. Обновите заказ.';
      }
    } else if (action === 'p') {
      if (order.status !== 'READY' || !['AWAITING', 'REPORTED'].includes(order.payment?.status ?? ''))
        return 'Оплата сейчас недоступна';
      await this.staff.confirmPayment(orderId, identity.userId, undefined, actor);
    } else if (action === 'u') {
      if (order.status !== 'READY' || order.type !== 'PICKUP' || order.payment?.status !== 'PAID')
        return 'Выдача сейчас недоступна';
      await this.staff.completePickup(orderId, actor);
    } else if (action === 'h') {
      if (order.status !== 'READY' || order.type !== 'DELIVERY' ||
        order.delivery?.provider !== 'OTHER' || order.delivery.status !== 'ASSIGNED')
        return 'Передача курьеру сейчас недоступна';
      await this.staff.handoff(orderId, actor);
    } else if (action === 'c') {
      if (order.status !== 'DELIVERING' || order.delivery?.provider !== 'OTHER')
        return 'Завершение доставки сейчас недоступно';
      await this.staff.completeDelivery(orderId, actor);
    } else if (action === 'b') {
      if (order.status !== 'READY') return 'Заказ уже изменился';
      await this.staff.reopen(orderId, actor);
    } else if (action === 'cancel_request' || action === 'z') {
      if (['COMPLETED', 'CANCELED'].includes(order.status)) return 'Заказ уже завершён';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'CANCEL', 'reason', 'Причина отмены (1–1000 символов). Ответьте на это сообщение.');
      return started ? 'Введите причину' : 'Не удалось начать ввод';
    } else if (action === 'w' || action === 'q') {
      const item = order.items.find(value => value.id === parsed?.arg);
      if (order.status !== 'ASSEMBLING' || !item || item.status !== 'PENDING' ||
        (action === 'w' ? item.unit !== 'GRAM' : item.unit === 'GRAM'))
        return 'Позиция изменилась. Обновите заказ.';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, item.id,
        'ITEM', 'qty', action === 'w' ? 'Введите фактический вес целым числом граммов.' :
          'Введите фактическое количество целым числом.');
      return started ? 'Введите количество' : 'Не удалось начать ввод';
    } else if (action === 'm' || action === 'r') {
      const item = order.items.find(value => value.id === parsed?.arg);
      if (order.status !== 'ASSEMBLING' || !item ||
        (action === 'm' && item.status !== 'PENDING') ||
        (action === 'r' && !['PICKED', 'MISSING'].includes(item.status)))
        return 'Позиция изменилась. Обновите заказ.';
      await this.staff.item(orderId, item.id, { status: action === 'm' ? 'MISSING' : 'PENDING' },
        identity.userId, actor);
    } else if (action === 'x' || action === 'xe') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      const extra = action === 'xe' ? order.extras.find(value =>
        value.id === parsed?.arg && value.status === 'ACTIVE') : undefined;
      if (action === 'xe' && !extra) return 'Дополнительная позиция изменилась';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'EXTRA', 'title', 'Название дополнительной позиции или услуги (до 120 символов).',
        extra ? { extraId: extra.id, version: extra.version } : {});
      return started ? 'Введите название' : 'Не удалось начать ввод';
    } else if (action === 'xd') {
      const extra = order.extras.find(value => value.id === parsed?.arg && value.status === 'ACTIVE');
      if (order.status !== 'ASSEMBLING' || !extra) return 'Дополнительная позиция изменилась';
      await this.staff.extra(orderId, identity.userId, null, extra.id, extra.version, actor);
    } else if (action === 'd') {
      if (order.status !== 'READY' || order.type !== 'DELIVERY' || order.payment?.status !== 'PAID' ||
        order.delivery?.provider === 'YANDEX') return 'Доставка сейчас недоступна';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'DELIVERY', 'courierName', 'Имя курьера (до 100 символов).');
      return started ? 'Введите данные курьера' : 'Не удалось начать ввод';
    } else if (action === 'i') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      const view = itemPage(order, parsed?.arg ?? 0);
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Позиции обновлены';
    } else if (action === 'v') {
      const item = order.items.find(value => value.id === parsed?.arg);
      if (!item) return 'Позиция не найдена';
      const view = itemView(order, item);
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Позиция обновлена';
    } else if (action === 'xl') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      const view = extraPage(order);
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Дополнительные позиции обновлены';
    } else if (action !== 'refresh' && action !== 'o') {
      return 'Некорректная кнопка';
    }
    await this.order(chatId, messageId, orderId);
    return 'Заказ обновлён';
  }
}
