import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { CoordinationService } from '../order/coordination.service.js';
import { OrderService } from '../order/order.service.js';
import { chatSchema } from '../order/coordination.schema.js';
import { botRequest } from './bot-api.js';
import type { CustomerTelegramSession } from '../db/gen/client.js';
import { customerShow, customerPrompt } from './customer-send.js';
import { CustomerShopService } from './customer-shop.service.js';
import { CustomerCheckoutService } from './customer-checkout.service.js';
import { customerError } from './customer-error.js';
import { shoppingAction } from './shopping-callback.js';
import { customerBotToken } from './bot-config.js';
import { customerAction, customerUpdate, customerView, type CustomerAction } from './customer-callback.js';
import {
  activeStatuses, amount, date, issueCard, orderCard, orderStatus, short, siteUrl,
  type Button, type Screen,
} from './customer-view.js';

type Identity = { id: number; userId: number; firstName: string | null; user: { name: string | null } };
type Target = { chatId: number; messageId?: number };

@Injectable()
export class CustomerUpdateService {
  private readonly logger = new Logger(CustomerUpdateService.name);
  constructor(
    private readonly db: DbService,
    private readonly coordination: CoordinationService,
    private readonly orders: OrderService,
    private readonly shop: CustomerShopService,
    private readonly checkout: CustomerCheckoutService,
  ) {}

  private show(target: Target, screen: Screen) { return customerShow(target, screen); }
  private async answer(id: string, text: string) {
    if (!await botRequest(customerBotToken(), 'answerCallbackQuery', {
      callback_query_id: id, text, cache_time: 0,
    }, 3000)) this.logger.warn('Customer Telegram answer failed');
  }
  private async menu(target: Target, identity: Identity) {
    const attention = await this.db.order.findFirst({
      where: { userId: identity.userId, OR: [
        { customerUnread: { gt: 0 } },
        { issues: { some: { status: 'WAITING_CUSTOMER' } } },
      ] }, select: { id: true },
    });
    const current = await this.db.order.findFirst({where:{userId:identity.userId,status:{in:activeStatuses}},select:{id:true}});
    const profile = siteUrl('/profile'), shop = siteUrl('/');
    const links: Button[] = [
      ...(profile ? [{ text: 'Профиль', url: profile }] : []),
      ...(shop ? [{ text: 'Открыть магазин', url: shop }] : []),
    ];
    return this.show(target, {
      text: 'Привет, ' + short(identity.user.name || identity.firstName || 'покупатель', 80) +
        '!\nВы вошли в KorzinaMarket через Telegram.\nВыбирайте продукты, оформляйте заказ и общайтесь с продавцом.',
      keyboard: { inline_keyboard: [
        [{ text: '🛍 Каталог', callback_data: 'catalog' }, { text: '🛒 Корзина', callback_data: 'cart' }],
        ...(current ? [[{ text: 'Текущий заказ', callback_data: 'current' }]] : []),
        [{ text: '📦 Мои заказы', callback_data: 'orders' }],
        ...(attention ? [[{ text: '💬 Сообщения / Вопросы', callback_data: 'attention' }]] : []),
        ...(links.length ? [links] : []),
        [{ text: 'ℹ️ Помощь', callback_data: 'help' }],
      ] },
    });
  }
  private async list(target: Target, identity: Identity, page = 0, attention = false) {
    const rows = await this.db.order.findMany({
      where: { userId: identity.userId, ...(attention ? { OR: [
        { customerUnread: { gt: 0 } }, { issues: { some: { status: 'WAITING_CUSTOMER' as const } } },
      ] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page * 5, take: 6,
      select: {
        id: true, publicId: true, status: true, total: true, finalTotal: true, createdAt: true,
        customerUnread: true, issues: { where: { status: 'WAITING_CUSTOMER' }, select: { id: true } },
      },
    });
    const visible = rows.slice(0, 5);
    const buttons: Button[][] = visible.map(order => [{
      text: '№' + order.id + (order.issues.length ? ' · Требуется решение' :
        order.customerUnread ? ' · Есть сообщения' : ' · ' + orderStatus[order.status]),
      callback_data: customerView(attention ? order.issues.length ? 'q' : 'm' : 'o', order.publicId),
    }]);
    if (!attention) buttons.push([
      ...(page ? [{ text: '← Новее', callback_data: 'c:l:' + (page - 1).toString(36) }] : []),
      ...(rows.length > 5 && page < 10000 ? [{ text: 'Ранее →', callback_data: 'c:l:' + (page + 1).toString(36) }] : []),
    ].filter(Boolean));
    buttons.push([{ text: 'Меню', callback_data: 'menu' }]);
    return this.show(target, {
      text: (attention ? 'Сообщения и вопросы по заказам' : 'Ваши заказы') + '\n\n' +
        (visible.map(order => '№' + order.id + ' · ' + orderStatus[order.status] + '\n' +
          amount(order.finalTotal ?? order.total) + ' · ' + date(order.createdAt)).join('\n\n') ||
          (attention ? 'Новых вопросов и сообщений нет.' : 'Здесь пока нет заказов.')),
      keyboard: { inline_keyboard: buttons.filter(row => row.length) },
    });
  }
  private async card(target: Target, identity: Identity, publicId: string, page = 0, issue = false) {
    const order = await this.orders.get(publicId, identity.userId);
    const coordination = await this.coordination.view({ publicId, userId: identity.userId });
    return this.show(target, issue ? issueCard(order, coordination.issues, page) : orderCard(order, coordination.issues, page));
  }
  private async messages(target: Target, identity: Identity, publicId: string, before = 0) {
    const actor = { publicId, userId: identity.userId };
    // One complete domain message fits even at the 2,000-character chat limit.
    const result = await this.coordination.messages(actor, { limit: 1, ...(before ? { before } : {}) });
    const last = result.messages[0];
    const authors = { CUSTOMER: 'Вы', SELLER: 'Продавец', ADMIN: 'Продавец', SYSTEM: 'Заказ' };
    const ok = await this.show(target, {
      text: 'Заказ №' + result.orderId + ' · Сообщения\n\n' +
        (last ? authors[last.authorType] + ' · ' + date(last.createdAt) + '\n' + last.text : 'Сообщений пока нет.'),
      keyboard: { inline_keyboard: [
        ...(last && result.hasMore ? [[{ text: '← Предыдущее', callback_data: customerView('m', publicId, last.id) }]] : []),
        [{ text: 'Последнее / Обновить', callback_data: customerView('m', publicId) }],
        [{ text: 'Написать продавцу', callback_data: customerView('w', publicId) }],
        [{ text: '← К заказу', callback_data: customerView('o', publicId) }],
      ] },
    });
    if (ok && last) await this.coordination.read(actor, last.id);
  }
  private async prompt(target: Target, identity: Identity, publicId: string) {
    const session = await this.coordination.reserveReply({ publicId, userId: identity.userId }, identity.id);
    return this.presentChat(target, identity, session);
  }
  private async presentChat(target: Target, identity: Identity, session: CustomerTelegramSession) {
    if (session.orderId === null) return;
    const promptMessageId = await customerPrompt(target.chatId, 'Сообщение продавцу по заказу №' + session.orderId +
      '.\nОтветьте именно на это сообщение (до 2000 символов).\n/resume — продолжить; /cancel — отмена. Ответ принимается в течение 10 минут.');
    // UNKNOWN must retain the durable, unbound reservation.
    if (!promptMessageId) return;
    await this.db.customerTelegramSession.updateMany({
      where: { id: session.id, identityId: identity.id, action: 'CHAT', step: 'PROMPT', promptMessageId: null, expiresAt: { gt: new Date() } },
      data: { step: 'TEXT', promptMessageId },
    });
  }
  private async resume(target: Target, identity: Identity) {
    const session = await this.checkout.resume(identity);
    if (!session) return this.show(target, {text:'Нет незавершённого ввода. Откройте /cart или нужный заказ.',
      keyboard:{inline_keyboard:[[{text:'Корзина',callback_data:'cart'},{text:'Мои заказы',callback_data:'orders'}]]}});
    if (session.action === 'CHECKOUT') return this.shop.present(target, identity, session);
    if (session.action !== 'CHAT' || session.orderId === null) return;
    const order = await this.db.order.findFirst({where:{id:session.orderId,userId:identity.userId},select:{publicId:true}});
    if (order) return this.presentChat(target,identity,session);
  }
  private async cancel(identity: Identity) {
    await this.db.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM "TelegramIdentity" WHERE id = ${identity.id} FOR UPDATE`;
      await db.customerTelegramSession.deleteMany({ where: { identityId: identity.id } });
    });
  }
  private async reply(target: Target, identity: Identity, text: string, promptMessageId?: number) {
    const session = await this.db.customerTelegramSession.findUnique({
      where: { identityId: identity.id }, include: { order: { select: { publicId: true, userId: true } } },
    });
    const notice = (message: string) => this.show(target, { text: message,
      keyboard: { inline_keyboard: [[{ text: '📦 Мои заказы', callback_data: 'orders' }]] } });
    if (!session || session.expiresAt <= new Date()) {
      if (session) await this.db.customerTelegramSession.deleteMany({ where: { id: session.id } });
      return notice('Сейчас нет открытого ввода сообщения. Откройте заказ и нажмите «Написать продавцу».');
    }
    if (session.action === 'CHECKOUT') {
      if (!promptMessageId) return notice('Ответьте на последнее приглашение. /resume — восстановить ввод.');
      return this.shop.present(target, identity, await this.checkout.reply(identity, text, promptMessageId));
    }
    if (session.action !== 'CHAT' || session.order?.userId !== identity.userId || !promptMessageId ||
      session.promptMessageId !== promptMessageId || session.step !== 'TEXT')
      return notice('Ответьте на последнее приглашение «Сообщение продавцу» для нужного заказа.');
    const parsed = chatSchema.safeParse({ text });
    if (!parsed.success) return notice('Сообщение должно содержать от 1 до 2000 символов. /cancel — отмена.');
    await this.coordination.post({ publicId: session.order.publicId, userId: identity.userId }, parsed.data.text, {
      sessionId: session.id, identityId: identity.id, promptMessageId,
    });
    await this.messages(target, identity, session.order.publicId);
  }

  private async action(target: Target, identity: Identity, action: CustomerAction) {
    switch (action.kind) {
      case 'menu': return this.menu(target, identity);
      case 'orders': return this.list(target, identity, action.page);
      case 'attention': return this.list(target, identity, 0, true);
      case 'cancel':
        await this.cancel(identity);
        return this.show(target, { text: 'Ввод отменён.', keyboard: { inline_keyboard: [[{ text: 'Меню', callback_data: 'menu' }]] } });
      case 'current': {
        const order = await this.db.order.findFirst({
          where: { userId: identity.userId, status: { in: activeStatuses } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { publicId: true },
        });
        return order ? this.card(target, identity, order.publicId) :
          this.show(target, { text: 'У вас пока нет текущих заказов.', keyboard: { inline_keyboard: [[{ text: 'Меню', callback_data: 'menu' }]] } });
      }
      case 'o': return this.card(target, identity, action.publicId, action.page);
      case 'q': return this.card(target, identity, action.publicId, action.page, true);
      case 'm': return this.messages(target, identity, action.publicId, action.page);
      case 'w': return this.prompt(target, identity, action.publicId);
      case 'd':
        await this.coordination.decide({ publicId: action.publicId, userId: identity.userId }, action.issueId, {
          version: action.version, action: action.action,
        });
        return this.card(target, identity, action.publicId);
    }
  }

  async handle(body: unknown) {
    const parsed = customerUpdate.safeParse(body);
    if (!parsed.success) return;
    const { message, callback_query: callback } = parsed.data;
    const sender = callback?.from ?? message?.from;
    const chat = callback?.message?.chat ?? message?.chat;
    if (!sender || !chat || chat.type !== 'private' || chat.id !== sender.id) return;
    const target: Target = { chatId: chat.id, ...(callback?.message ? { messageId: callback.message.message_id } : {}) };
    let ack = 'Готово';
    let shoppingRequest = false;
    try {
      const command = message?.text?.trim().split(/\s+/)[0];
      const action = callback ? customerAction(callback.data ?? '') :
        command === '/start' || command === '/menu' ? { kind: 'menu' as const } :
        command === '/orders' ? { kind: 'orders' as const, page: 0 } :
        command === '/cancel' ? { kind: 'cancel' as const } : null;
      const shopping = shoppingAction(callback?.data ?? command?.slice(1) ?? '');
      shoppingRequest = Boolean(shopping);
      const extra = command === '/current' ? {kind:'current' as const} :
        command === '/messages' ? {kind:'attention' as const} : null;
      if (callback && !action && !shopping) { ack = 'Некорректная кнопка'; return; }
      const identity = await this.db.telegramIdentity.findUnique({
        where: { telegramUserId: BigInt(sender.id) },
        select: { id: true, userId: true, firstName: true, user: { select: { name: true } } },
      });
      if (!identity) {
        const url = siteUrl('/');
        await this.show(target, { text: 'Чтобы увидеть свои заказы, откройте KorzinaMarket и войдите через Telegram. Затем вернитесь сюда и нажмите /start.',
          keyboard: { inline_keyboard: url ? [[{ text: 'Открыть магазин', url }]] : [] } });
        return;
      }
      if (command === '/start') await this.db.telegramIdentity.update({
        where: { id: identity.id },
        data: { customerBotStartedAt: new Date(), customerBotBlockedAt: null },
      });
      if (shopping?.kind === 'resume') await this.resume(target, identity);
      else if (shopping) await this.shop.handle(target, identity, shopping);
      else if (extra) await this.action(target, identity, extra);
      else if (action) await this.action(target, identity, action);
      else if (message?.text && !message.text.startsWith('/'))
        await this.reply({ chatId: chat.id }, identity, message.text, message.reply_to_message?.message_id);
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      ack = status === 404 ? 'Заказ недоступен' :
        status === 409 ? 'Ситуация по заказу уже изменилась. Обновите заказ.' :
        status === 429 ? 'Слишком много сообщений. Подождите минуту.' : 'Не удалось выполнить действие';
      ack = customerError(error, shoppingRequest) ?? ack;
      if (status >= 500) this.logger.warn('Customer Telegram update failed');
      if (!callback) await this.show({ chatId: chat.id }, { text: ack,
        keyboard: { inline_keyboard: [[{ text: '📦 Мои заказы', callback_data: 'orders' }]] } });
    } finally {
      if (callback) await this.answer(callback.id, ack);
    }
  }
}
