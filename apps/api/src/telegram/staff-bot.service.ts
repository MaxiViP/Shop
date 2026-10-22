import { isStaff, ownershipSelect } from '../auth/permissions.js';
import { variableWeight } from '../product/sale.js';
import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { StaffService } from '../staff/staff.service.js';
import { staffActor } from '../staff/audit.js';
import { callbackIdSchema, parseAction } from './callback.js';
import { StaffLinkService } from './staff-link.service.js';
import { StaffBotFlowService } from './staff-bot-flow.service.js';
import { reviewSnapshot, flowError, knownFlowError, uncertainMutation } from './staff-flow.js';
import { parseStaffAction, parseStaffQueue, staffData, staffQueueData, staffUpdate, staffOrderCommand, clean,
  type StaffCallback, type StaffMessage, type StaffQueueFilter } from './staff-bot.js';
import { activeStatuses, assemblyView, canQuickConfirm, canReview, dashboard, extraPage, issuePage, itemPage, itemView, staffHelp, workOverview, statusText,
  type Keyboard } from './staff-bot-view.js';
import { TelegramService } from './telegram.service.js';

type Identity = { id: number; userId: number; user: { role: 'USER' | 'SELLER' | 'ADMIN'; ownedPoints?: { marketPointId: number }[] } };

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
        answer = uncertainMutation;
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
      select: { id: true, userId: true, user: { select: { role: true, ...ownershipSelect } } },
    });
    return identity && isStaff(identity.user) ? identity : null;
  }

  private async message(message: StaffMessage, identity: Identity): Promise<void> {
    const chatId = message.chat.id;
    const text = message.text?.trim() ?? '';
    if (text === '/cancel') {
      const canceled = await this.flows.cancel(identity.id);
      await this.telegram.sendStaff(chatId, canceled ? 'Ввод отменён. Отправьте /orders.' : uncertainMutation);
      return;
    }
    if (text === '/resume') return this.flows.resume(identity.id, chatId);
    if (text === '/start') {
      await this.db.staffTelegramIdentity.update({
        where: { id: identity.id }, data: { botStartedAt: new Date(), blockedAt: null },
      });
      return this.overview(chatId);
    }
    if (text === '/help' || text === '/order') {
      const view = staffHelp();
      return this.render(chatId, null, view.text, view.keyboard);
    }
    if (text === '/work') return this.overview(chatId);
    if (text === '/orders') return this.orders(chatId);
    if (text === '/attention') return this.orders(chatId, undefined, 'seller');
    if (text === '/waiting') return this.orders(chatId, undefined, 'customer');
    const orderId = staffOrderCommand(text);
    if (orderId && (text.startsWith('/') || !message.reply_to_message)) return this.order(chatId, null, orderId);
    if (text.startsWith('/')) {
      const view = staffHelp();
      return this.render(chatId, null, view.text, view.keyboard);
    }
    const result = await this.flows.input(message, identity.id, staffActor({ id: identity.userId, ...identity.user }));
    if (result) await this.refreshSaved(chatId, result.dashboardMessageId, result.orderId, result.itemId);
  }

  private async refreshSaved(chatId: number, messageId: number | null, orderId: number, itemId?: number): Promise<void> {
    try {
      if (itemId === undefined) await this.order(chatId, messageId, orderId);
      else await this.assembly(chatId, messageId, orderId, itemId, itemId);
    }
    catch { this.logger.warn('Staff Telegram saved order refresh failed'); }
  }

  private async overview(chatId: number, messageId?: number): Promise<void> {
    const counts = await Promise.all(['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'].map(status =>
      this.db.order.count({ where: { status: status as typeof activeStatuses[number] } })));
    const active = { status: { in: [...activeStatuses] } };
    const [seller, customer] = await Promise.all([
      this.db.order.count({ where: { ...active, issues: { some: { OR: [
        { status: 'WAITING_SELLER' },
        { status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT', replacementItemId: { not: null },
          replacementItem: { is: { status: 'PENDING' } } },
      ] } } } }),
      this.db.order.count({ where: { ...active, issues: { some: { status: 'WAITING_CUSTOMER' } } } }),
    ]);
    const view = workOverview({ new: counts[0]!, confirmed: counts[1]!, assembly: counts[2]!,
      ready: counts[3]!, delivery: counts[4]!, seller, customer });
    await this.render(chatId, messageId, view.text, view.keyboard);
  }

  private async orders(chatId: number, messageId?: number, filter: StaffQueueFilter = 'all', page = 0): Promise<void> {
    const active = { status: { in: [...activeStatuses] } };
    const sellerIssue = { OR: [
      { status: 'WAITING_SELLER' },
      { status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT', replacementItemId: { not: null },
        replacementItem: { is: { status: 'PENDING' } } },
    ] } satisfies Prisma.OrderIssueWhereInput;
    const customerIssue = { status: 'WAITING_CUSTOMER' } satisfies Prisma.OrderIssueWhereInput;
    const queueStatuses = { new: ['NEW'], assembly: ['CONFIRMED', 'ASSEMBLING'], ready: ['READY'], delivery: ['DELIVERING'] } as const;
    const statusFilter = filter in queueStatuses ? { status: { in: [...queueStatuses[filter as keyof typeof queueStatuses]] } } : active;
    const issueFilter = filter === 'seller' ? sellerIssue : filter === 'customer' ? customerIssue : null;
    const [found, sellerCount, customerCount] = await Promise.all([
      this.db.order.findMany({
        where: { ...statusFilter, ...(issueFilter ? { issues: { some: issueFilter } } : {}) },
        take: 13, skip: page * 12, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, status: true, customerName: true, type: true,
          issues: { where: issueFilter ?? { OR: [sellerIssue, customerIssue] }, take: 3,
            orderBy: [{ status: 'desc' }, { id: 'asc' }], select: { orderItemId: true, status: true,
              resolution: true, replacementItemId: true,
              replacementItem: { select: { id: true, status: true, productName: true } },
              orderItem: { select: { productName: true } } } } },
      }),
      this.db.order.count({ where: { ...active, issues: { some: sellerIssue } } }),
      this.db.order.count({ where: { ...active, issues: { some: customerIssue } } }),
    ]);
    const orders = found.slice(0, 12);
    const labels = { all: 'Активные заказы', seller: 'Нужно вам', customer: 'Ждём покупателя',
      new: 'Новые заказы', assembly: 'Подтверждены и в сборке', ready: 'Готовы к выдаче и доставке', delivery: 'Доставляются' };
    const lines = [labels[filter] + ' · страница ' + (page + 1),
      'Заказов: нужно вам ' + sellerCount + ' · ждём покупателя ' + customerCount];
    const rows: Keyboard['inline_keyboard'] = [[
      { text: 'Все', callback_data: staffQueueData('all') },
      { text: '❗ Нужно вам · ' + sellerCount, callback_data: staffQueueData('seller') },
    ], [{ text: '⏳ Ждём покупателя · ' + customerCount, callback_data: staffQueueData('customer') }]];
    for (const order of orders) {
      lines.push('', '#' + order.id + ' · ' + statusText[order.status] + ' · ' + clean(order.customerName, 35) +
        (order.type === 'PICKUP' ? ' · самовывоз' : ' · доставка'));
      rows.push([{ text: '#' + order.id + ' · ' + statusText[order.status], callback_data: staffData(order.id, 'o') }]);
      for (const issue of order.issues.slice(0, 2)) {
        const replacement = issue.status === 'RESOLVED' && issue.resolution === 'ACCEPT_REPLACEMENT' &&
          issue.replacementItem?.status === 'PENDING' ? issue.replacementItem : null;
        const text = (replacement ? '✅ Замена одобрена: ' : issue.status === 'WAITING_SELLER' ? '❗ Исправить: ' : '⏳ Ждём: ') +
          clean(replacement?.productName ?? issue.orderItem.productName, 32);
        lines.push(text);
        rows.push([{ text: '#' + order.id + ' · ' + text, callback_data: staffData(order.id, 'v', replacement?.id ?? issue.orderItemId) }]);
      }
    }
    if (!orders.length) lines.push('', page ? 'На этой странице заказов нет. Вернитесь назад.' : 'В этой очереди заказов нет.');
    const nav: Keyboard['inline_keyboard'][number] = [];
    if (page > 0) nav.push({ text: '← Предыдущие', callback_data: staffQueueData(filter, page - 1) });
    if (found.length > 12 && page < 10000) nav.push({ text: 'Следующие →', callback_data: staffQueueData(filter, page + 1) });
    if (nav.length) rows.push(nav);
    rows.push([{ text: 'Рабочий обзор', callback_data: 'sw' }]);
    rows.push([{ text: '🔄 Обновить очередь', callback_data: staffQueueData(filter, page) }]);
    await this.render(chatId, messageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async order(chatId: number, messageId: number | null, orderId: number): Promise<void> {
    const order = await this.staff.get(orderId);
    const view = dashboard(order, this.telegram.staffOrderUrl(orderId));
    await this.render(chatId, messageId, view.text, view.keyboard);
  }

  private async assembly(chatId: number, messageId: number | null, orderId: number,
    afterItemId?: number, savedItemId?: number): Promise<void> {
    const order = await this.staff.get(orderId);
    const view = assemblyView(order, this.telegram.staffOrderUrl(orderId), afterItemId, savedItemId);
    await this.render(chatId, messageId, view.text, view.keyboard);
  }

  private async render(chatId: number, messageId: number | null | undefined, text: string,
    keyboard: Keyboard): Promise<void> {
    if (messageId) await this.telegram.editStaff(chatId, messageId, text.slice(0, 3900), keyboard);
    else await this.telegram.sendStaff(chatId, text.slice(0, 3900), keyboard);
  }

  private async callback(callback: StaffCallback, identity: Identity): Promise<string> {
    if (callback.data === 'sw') {
      await this.overview(callback.message.chat.id, callback.message.message_id);
      return 'Обзор обновлён';
    }
    const queue = parseStaffQueue(callback.data);
    if (queue) {
      await this.orders(callback.message.chat.id, callback.message.message_id, queue.filter, queue.page);
      return 'Очередь обновлена';
    }
    const legacy = parseAction(callback.data);
    const parsed = parseStaffAction(callback.data);
    if (!legacy && !parsed) return 'Некорректная кнопка';
    const orderId = (legacy ?? parsed)!.orderId;
    const action = legacy?.action ?? parsed!.action;
    const actor = staffActor({ id: identity.userId, ...identity.user });
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (action === 'cancel_back' || action === 'zb') {
      if (!await this.flows.cancel(identity.id, orderId)) return uncertainMutation;
      await this.order(chatId, messageId, orderId);
      return 'Ввод отменён';
    }
    if (action === 'cancel_confirm' || action === 'zy' || action === 'xs' || action === 'ds' ||
      action === 'ry' || action === 'xy' || action === 'fy' || action === 'by' || action === 'py') {
      const kind = action === 'cancel_confirm' || action === 'zy' ? 'CANCEL' :
        action === 'xs' ? 'EXTRA' : action === 'ds' ? 'DELIVERY' :
        action === 'ry' ? 'RESET_ITEM' : action === 'xy' ? 'REMOVE_EXTRA' :
          action === 'fy' ? 'FINISH_ASSEMBLY' : action === 'py' ? 'PAYMENT' : 'REOPEN';
      try {
        const done = await this.flows.finish(identity.id, actor, orderId, kind, parsed?.code);
        if (!done) return 'Ввод уже изменился. /resume — проверить ввод, /orders — проверить заказ.';
      } catch (error) {
        if (knownFlowError(error)) return flowError(error);
        throw error;
      }
      await this.refreshSaved(chatId, messageId, orderId);
      return 'Заказ обновлён. /orders — открыть заказ.';
    }

    const order = await this.staff.get(orderId);
    if (action === 'confirm') {
      if (order.status !== 'NEW') return 'Статус заказа уже изменился';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      await this.staff.confirm(orderId, actor);
    } else if (action === 'assembly') {
      if (order.status !== 'CONFIRMED') return 'Статус заказа уже изменился';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      await this.staff.startAssembly(orderId, actor);
      await this.assembly(chatId, messageId, orderId);
      return 'Сборка началась';
    } else if (action === 'f') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      if (!canReview(order, 'FINISH_ASSEMBLY')) {
        await this.order(chatId, messageId, orderId);
        return 'Сначала обработайте позиции и вопросы покупателя';
      }
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'FINISH_ASSEMBLY', 'CONFIRM', { snapshot: reviewSnapshot(order) });
      return started ? 'Проверьте сборку перед завершением' : 'Проверка не открыта. /resume — продолжить ввод.';
    } else if (action === 'p') {
      if (order.status !== 'READY' || !['AWAITING', 'REPORTED'].includes(order.payment?.status ?? ''))
        return 'Оплата сейчас недоступна';
      if (!canReview(order, 'PAYMENT')) return 'Сумма оплаты изменилась. Обновите заказ';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'PAYMENT', 'CONFIRM', { snapshot: reviewSnapshot(order) });
      return started ? 'Проверьте поступление оплаты' : 'Проверка не открыта. /resume — продолжить ввод.';
    } else if (action === 'u') {
      if (order.status !== 'READY' || order.type !== 'PICKUP' || order.payment?.status !== 'PAID')
        return 'Выдача сейчас недоступна';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      await this.staff.completePickup(orderId, actor);
    } else if (action === 'h') {
      if (order.status !== 'READY' || order.type !== 'DELIVERY' ||
        order.delivery?.provider !== 'OTHER' || order.delivery.status !== 'ASSIGNED')
        return 'Передача курьеру сейчас недоступна';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      await this.staff.handoff(orderId, actor);
    } else if (action === 'c') {
      if (order.status !== 'DELIVERING' || order.delivery?.provider !== 'OTHER')
        return 'Завершение доставки сейчас недоступно';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      await this.staff.completeDelivery(orderId, actor);
    } else if (action === 'b') {
      if (order.status !== 'READY') return 'Заказ уже изменился';
      if (!canReview(order, 'REOPEN')) return 'Возврат к сборке сейчас недоступен';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'REOPEN', 'CONFIRM', { snapshot: reviewSnapshot(order) });
      return started ? 'Проверьте возврат к сборке' : 'Проверка не открыта. /resume — продолжить ввод.';
    } else if (action === 'cancel_request' || action === 'z') {
      if (['COMPLETED', 'CANCELED'].includes(order.status)) return 'Заказ уже завершён';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'CANCEL', 'reason');
      return started ? 'Введите причину' : 'Запрос не привязан. /resume — продолжить ввод.';
    } else if (action === 'w' || action === 'q') {
      const item = order.items.find(value => value.id === parsed?.arg);
      if (order.status !== 'ASSEMBLING' || !item || item.status !== 'PENDING' ||
        (action === 'w' ? item.unit !== 'GRAM' : item.unit === 'GRAM'))
        return 'Позиция изменилась. Обновите заказ.';
      if (variableWeight(item)) {
        const view = itemView(order, item, this.telegram.staffOrderUrl(orderId));
        await this.render(chatId, messageId, view.text, view.keyboard);
        return 'Взвесьте каждый экземпляр на сайте';
      }
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, item.id,
        'ITEM', 'qty');
      return started ? 'Введите количество' : 'Запрос не привязан. /resume — продолжить ввод.';
    } else if (action === 'a' || action === 'k') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      const index = action === 'a' ? order.items.findIndex(item => item.id === parsed?.arg) : 0;
      if (action === 'a' && (index < 0 || !canQuickConfirm(order, order.items[index]!)))
        return 'Позиция изменилась. Обновите заказ.';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      const count = await this.staff.confirmDiscrete(orderId, actor,
        action === 'a' ? parsed?.arg : undefined);
      await this.assembly(chatId, messageId, orderId,
        action === 'a' ? parsed?.arg : undefined, action === 'a' ? parsed?.arg : undefined);
      return count ? 'Позиции обновлены' : 'Позиции уже изменились';
    } else if (action === 'm' || action === 'r') {
      const item = order.items.find(value => value.id === parsed?.arg);
      if (order.status !== 'ASSEMBLING' || !item ||
        (action === 'm' && item.status !== 'PENDING') ||
        (action === 'r' && !['PICKED', 'MISSING'].includes(item.status)))
        return 'Позиция изменилась. Обновите заказ.';
      if (action === 'r') {
        if (!canReview(order, 'RESET_ITEM', item.id)) return 'Возврат позиции сейчас недоступен';
        const started = await this.flows.start(identity.id, chatId, messageId, orderId, item.id,
          'RESET_ITEM', 'CONFIRM', { snapshot: reviewSnapshot(order) });
        return started ? 'Проверьте возврат позиции' : 'Проверка не открыта. /resume — продолжить ввод.';
      }
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      await this.staff.item(orderId, item.id, { status: 'MISSING' },
        identity.userId, actor);
      await this.refreshSaved(chatId, messageId, orderId, item.id);
      return 'Отсутствие отмечено. Следующая позиция';
    } else if (action === 'x' || action === 'xe') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      const extra = action === 'xe' ? order.extras.find(value =>
        value.id === parsed?.arg && value.status === 'ACTIVE') : undefined;
      if (action === 'xe' && !extra) return 'Дополнительная позиция изменилась';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'EXTRA', 'title',
        extra ? { extraId: extra.id, version: extra.version } : {});
      return started ? 'Введите название' : 'Запрос не привязан. /resume — продолжить ввод.';
    } else if (action === 'xd') {
      const extra = order.extras.find(value => value.id === parsed?.arg && value.status === 'ACTIVE');
      if (order.status !== 'ASSEMBLING' || !extra) return 'Дополнительная позиция изменилась';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'REMOVE_EXTRA', 'CONFIRM', { extraId: extra.id, version: extra.version, snapshot: reviewSnapshot(order) });
      return started ? 'Проверьте отмену дополнительной позиции' : 'Проверка не открыта. /resume — продолжить ввод.';
    } else if (action === 'd') {
      if (order.status !== 'READY' || order.type !== 'DELIVERY' || order.payment?.status !== 'PAID' ||
        order.delivery?.provider === 'YANDEX') return 'Доставка сейчас недоступна';
      const started = await this.flows.start(identity.id, chatId, messageId, orderId, null,
        'DELIVERY', 'courierName');
      return started ? 'Введите данные курьера' : 'Запрос не привязан. /resume — продолжить ввод.';
    } else if (action === 'j') {
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      const view = issuePage(order, parsed?.arg ?? 0);
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Вопросы обновлены';
    } else if (action === 'i') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      const view = itemPage(order, parsed?.arg ?? 0);
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Позиции обновлены';
    } else if (action === 'v') {
      const item = order.items.find(value => value.id === parsed?.arg);
      if (!item) return 'Позиция не найдена';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      const view = itemView(order, item, this.telegram.staffOrderUrl(orderId));
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Позиция обновлена';
    } else if (action === 'xl') {
      if (order.status !== 'ASSEMBLING') return 'Сборка уже завершена';
      if (!await this.flows.cancel(identity.id)) return uncertainMutation;
      const view = extraPage(order, parsed?.arg ?? 0);
      await this.render(chatId, messageId, view.text, view.keyboard);
      return 'Дополнительные позиции обновлены';
    } else if (action !== 'refresh' && action !== 'o') {
      return 'Некорректная кнопка';
    }
    await this.order(chatId, messageId, orderId);
    return 'Заказ обновлён';
  }
}
