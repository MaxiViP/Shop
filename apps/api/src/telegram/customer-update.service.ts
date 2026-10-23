import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { CoordinationService } from '../order/coordination.service.js';
import { OrderService } from '../order/order.service.js';
import { chatSchema } from '../order/coordination.schema.js';
import { botMessage, botRequest } from './bot-api.js';
import type { CustomerTelegramSession, UserRole, Prisma } from '../db/gen/client.js';
import { customerShow, customerPrompt } from './customer-send.js';
import { CustomerShopService } from './customer-shop.service.js';
import { CustomerCheckoutService } from './customer-checkout.service.js';
import { customerError } from './customer-error.js';
import { shoppingAction } from './shopping-callback.js';
import { customerBotToken } from './bot-config.js';
import { serialUpdate } from './updates.js';
import { pageInfo } from './page.js';
import { screenNotice } from './rich.js';
import { phone } from '../common/phone.js';
import { customerAction, customerUpdate, customerView, type CustomerAction } from './customer-callback.js';
import {
  activeStatuses, amount, date, issueCard, orderCard, orderStatus, webAppUrl, customerMenu, customerOnboardingMenu, cancelOrderScreen,
  type Button, type Screen,
} from './customer-view.js';

type Identity = { id: number; userId: number; firstName: string | null; phoneNumber: string | null; phoneVerified: boolean; user: { name: string | null; role: UserRole } };
type Sender = { id: number; username?: string; first_name?: string; last_name?: string };
type Target = { chatId: number; messageId?: number };
const identitySelect = { id: true, userId: true, firstName: true, phoneNumber: true, phoneVerified: true,
  user: { select: { name: true, role: true } } } as const;

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
  private async start(sender: Sender): Promise<Identity> {
    const telegramUserId = BigInt(sender.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.db.$transaction(async db => {
          await db.$executeRaw`SELECT pg_advisory_xact_lock(704003, hashtext(${String(sender.id)}))`;
          const identity = await db.telegramIdentity.findUnique({
            where: { telegramUserId }, select: identitySelect,
          });
          if (identity && identity.user.role !== 'USER') return identity;
          const activation = { customerBotStartedAt: new Date(), customerBotBlockedAt: null };
          if (identity) return db.telegramIdentity.update({
            where: { id: identity.id }, data: activation, select: identitySelect,
          });
          return db.telegramIdentity.create({
            data: {
              telegramUserId,
              username: sender.username ?? null,
              firstName: sender.first_name ?? null,
              lastName: sender.last_name ?? null,
              ...activation,
              user: { create: {
                role: 'USER', phone: null,
                name: [sender.first_name, sender.last_name].filter(Boolean).join(' ') || null,
              } },
            },
            select: identitySelect,
          });
        });
      } catch (error) {
        if (attempt === 0 && typeof error === 'object' && error !== null &&
          'code' in error && error.code === 'P2002') continue;
        throw error;
      }
    }
    throw new Error('Customer Telegram start retry exhausted');
  }
  private async requestPhone(chatId: number, invalid = false) {
    const ok = await botMessage(customerBotToken(), 'sendMessage', {
      chat_id: chatId,
      text: invalid
        ? 'Поделитесь только своим номером Telegram. Нажмите «Поделиться номером».'
        : 'Для доставки нужен ваш номер телефона. Нажмите «Поделиться номером».',
      reply_markup: {
        keyboard: [[{ text: 'Поделиться номером', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    if (!ok) this.logger.warn('Customer Telegram phone prompt failed');
  }
  private async removeContactKeyboard(chatId: number) {
    const ok = await botMessage(customerBotToken(), 'sendMessage', {
      chat_id: chatId,
      text: 'Номер подтверждён.',
      reply_markup: { remove_keyboard: true },
    });
    if (!ok) this.logger.warn('Customer Telegram keyboard removal failed');
  }
  private async acceptContact(identity: Identity, sender: Sender, rawPhone: string): Promise<Identity> {
    const number = phone(rawPhone);
    return this.db.$transaction(async db => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(704003, hashtext(${String(sender.id)}))`;
      const current = await db.telegramIdentity.findUniqueOrThrow({
        where: { id: identity.id }, select: identitySelect,
      });
      if (current.user.role !== 'USER' || (current.phoneVerified && current.phoneNumber)) return current;
      return db.telegramIdentity.update({
        where: { id: identity.id },
        data: { phoneNumber: number, phoneVerified: true },
        select: identitySelect,
      });
    });
  }
  private async answer(id: string, text: string) {
    if (!await botRequest(customerBotToken(), 'answerCallbackQuery', {
      callback_query_id: id, text, cache_time: 0,
    }, 3000)) this.logger.warn('Customer Telegram answer failed');
  }
  private async menu(target: Target, identity: Identity) {
    const [question, unread, current, cartLabel] = await Promise.all([
      this.db.order.findFirst({
        where: { userId: identity.userId, status: 'ASSEMBLING', assemblyFinalizedAt: null,
          issues: { some: { status: 'WAITING_CUSTOMER' } },
          OR: [{ payment: null }, { payment: { is: { status: { notIn: ['REPORTED', 'PAID'] } } } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, customerUnread: true, issues: { where: { status: 'WAITING_CUSTOMER' }, select: { id: true } } },
      }),
      this.db.order.findFirst({ where: { userId: identity.userId, customerUnread: { gt: 0 } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, customerUnread: true, issues: { where: { status: 'WAITING_CUSTOMER' }, select: { id: true } } } }),
      this.db.order.findFirst({ where: { userId: identity.userId, status: { in: activeStatuses } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true } }),
      this.shop.cartLabel(identity),
    ]);
    return this.show(target, customerMenu(identity, { attention: question ?? unread, current, cartLabel }));
  }
  private async list(target: Target, identity: Identity, page = 0, attention = false): Promise<boolean> {
    const where = { userId: identity.userId, ...(attention ? { OR: [
      { customerUnread: { gt: 0 } }, { status: 'ASSEMBLING', assemblyFinalizedAt: null, issues: { some: { status: 'WAITING_CUSTOMER' as const } } },
    ] } : {}) } satisfies Prisma.OrderWhereInput;
    const info = pageInfo(await this.db.order.count({ where }), page, 5);
    page = info.page;
    const rows = await this.db.order.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page * 5, take: 6,
      select: {
        id: true, publicId: true, status: true, total: true, finalTotal: true, createdAt: true,
        assemblyFinalizedAt: true, payment: { select: { status: true } },
        customerUnread: true, issues: { where: { status: 'WAITING_CUSTOMER' }, select: { id: true } },
      },
    });
    if (!rows.length && page) return this.list(target, identity, 0, attention);
    const visible = rows.slice(0, 5).map(order => ({ ...order, pending: order.status === 'ASSEMBLING' &&
      !order.assemblyFinalizedAt && !['PAID', 'REPORTED'].includes(order.payment?.status ?? '') ? order.issues.length : 0 }));
    const buttons: Button[][] = visible.map(order => [{
      text: '№' + order.id + (order.pending ? ' · Требуется решение' :
        order.customerUnread ? ' · Есть обновления в чате' : ' · ' + orderStatus[order.status]),
      callback_data: customerView(attention ? order.pending ? 'q' : 'm' : 'o', order.publicId),
    }]);
    const prefix = attention ? 'c:n:' : 'c:l:';
    buttons.push([
      ...(page ? [{ text: '← Новее', callback_data: prefix + (page - 1).toString(36) }] : []),
      ...(rows.length > 5 && page < 10000 ? [{ text: 'Ранее →', callback_data: prefix + (page + 1).toString(36) }] : []),
    ]);
    if (attention) buttons.push([{ text: '🔄 Обновить очередь', callback_data: 'attention' }]);
    buttons.push([{ text: '🛍 В магазин', callback_data: 'catalog' }, { text: 'Меню', callback_data: 'menu' }]);
    return this.show(target, {
      text: (attention ? '❗ Сообщения и вопросы по заказам' : '📦 Ваши заказы') +
        '\n' + info.label + '\n\n' +
        (visible.map(order => '№' + order.id + ' · ' + orderStatus[order.status] + '\n' +
          amount(order.finalTotal ?? order.total) + ' · ' + date(order.createdAt) +
          (order.pending ? '\n❗ Вопросов: ' + order.pending : '') +
          (order.customerUnread ? '\n💬 Непрочитанных обновлений: ' + order.customerUnread : '')).join('\n\n') ||
          (attention ? 'Новых вопросов и сообщений нет.' : 'Здесь пока нет заказов.')),
      keyboard: { inline_keyboard: buttons.filter(row => row.length) },
    });
  }
  private async card(target: Target, identity: Identity, publicId: string, page = 0, issue = false) {
    const order = await this.orders.get(publicId, identity.userId);
    if (!issue) return this.show(target, orderCard(order, page));
    const coordination = await this.coordination.view({ publicId, userId: identity.userId });
    return this.show(target, issueCard(order, coordination.issues, page));
  }
  private async decisionCard(target: Target, identity: Identity, publicId: string, afterIssueId: number, feedback: string) {
    const order = await this.orders.get(publicId, identity.userId);
    const coordination = await this.coordination.view({ publicId, userId: identity.userId });
    const waiting = coordination.issues.filter(issue => issue.status === 'WAITING_CUSTOMER' && issue.actions.length);
    const next = waiting.findIndex(issue => issue.id > afterIssueId);
    const screen = waiting.length ? issueCard(order, coordination.issues, next < 0 ? 0 : next) : orderCard(order);
    return this.show(target, screenNotice(screen, feedback));
  }
  private async messages(target: Target, identity: Identity, publicId: string, cursor = 0, direction: 'before' | 'after' | 'latest' = 'before') {
    const actor = { publicId, userId: identity.userId };
    // One full domain message fits even at the 2,000-character chat limit.
    const result = await this.coordination.messages(actor, { limit: 1,
      ...(cursor && direction !== 'latest' ? { [direction]: cursor } : {}) });
    const unreadFirst = !cursor && direction !== 'latest';
    const revision = unreadFirst && !result.unreadMessage ? result.unreadRevision : null;
    const last = unreadFirst ? result.unreadMessage ?? revision?.message ?? result.messages[0] : result.messages[0];
    const authors = { CUSTOMER: 'Вы', SELLER: 'Продавец', ADMIN: 'Продавец', SYSTEM: 'Заказ' };
    const url = last ? webAppUrl('/order/' + publicId + '?chatMessage=' + last.id + '#order-chat') : undefined;
    const skippedUnread = last && result.unreadMessage && last.id > result.unreadMessage.id;
    const ok = await this.show(target, {
      text: 'Заказ №' + result.orderId + ' · Сообщения\n\n' +
        (last ? (revision ? '🖍 Продавец обновил подпись к фото.\n' : '') + authors[last.authorType] + ' · ' + date(last.createdAt) + '\n' +
          (last.revisionText || last.text || (last.image ? '📷 Фото по заказу' : '')) +
          (last.image ? '\n\n📷 Фото и отметки доступны на сайте.' : '') +
          (revision ? '\nПросмотр фото на сайте снимет индикатор обновления.' : '') : cursor ? 'Больше сообщений в этом направлении нет.' : 'Сообщений пока нет.') +
        (skippedUnread ? '\n\nЕсть более ранние непрочитанные сообщения. Нажмите «Читать непрочитанные».' : ''),
      keyboard: { inline_keyboard: [
        [{ text: '📨 Читать непрочитанные / Обновить', callback_data: customerView('m', publicId), style: 'primary' }],
        [{ text: 'Написать продавцу', callback_data: customerView('w', publicId) }],
        ...(last && (last.image || revision) && url ? [[{ text: '📷 Открыть фото и отметки', web_app: { url } }]] : []),
        ...(last ? [[
          { text: '← Предыдущее', callback_data: customerView('m', publicId, last.id) },
          { text: 'Следующее →', callback_data: customerView('n', publicId, last.id) },
        ]] : []),
        [{ text: 'К последнему сообщению', callback_data: customerView('t', publicId) },
          { text: '← К заказу', callback_data: customerView('o', publicId) }],
      ] },
    });
    // Do not skip unseen messages or acknowledge an unseen photo revision.
    if (ok && last && !revision && !skippedUnread) await this.coordination.read(actor, last.id);
  }
  private async prompt(target: Target, identity: Identity, publicId: string) {
    const session = await this.coordination.reserveReply({ publicId, userId: identity.userId }, identity.id);
    return this.presentChat(target, identity, session);
  }
  private async presentChat(target: Target, identity: Identity, session: CustomerTelegramSession) {
    if (session.orderId === null) return;
    const promptMessageId = await customerPrompt(target.chatId, 'Сообщение продавцу по заказу №' + session.orderId +
      '.\nНажмите «Ответить» на этом сообщении и напишите текст (до 2000 символов).\n/resume — продолжить; /cancel — отмена. Ответ принимается в течение 10 минут.');
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
      keyboard: { inline_keyboard: [[{ text: '📦 Мои заказы', callback_data: 'orders' }, { text: 'Меню', callback_data: 'menu' }]] } });
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
    if (action.kind !== 'w' && action.kind !== 'd') await this.cancel(identity);
    switch (action.kind) {
      case 'menu':
      case 'cancel':
      case 'verify_phone': return this.menu(target, identity);
      case 'orders': return this.list(target, identity, action.page);
      case 'attention': return this.list(target, identity, action.page, true);
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
      case 'n': return this.messages(target, identity, action.publicId, action.page, 'after');
      case 't': return this.messages(target, identity, action.publicId, 0, 'latest');
      case 'w': return this.prompt(target, identity, action.publicId);
      case 'd': {
        if (action.action === 'CANCEL_ORDER' && !action.confirmed) {
          const order = await this.orders.get(action.publicId, identity.userId);
          const state = await this.coordination.view({ publicId: action.publicId, userId: identity.userId });
          const issue = state.issues.find(issue => issue.id === action.issueId && issue.version === action.version &&
            issue.status === 'WAITING_CUSTOMER' && issue.actions.includes('CANCEL_ORDER'));
          if (!issue) return this.decisionCard(target, identity, action.publicId, 0, 'Ситуация изменилась. Проверьте актуальные вопросы.');
          return this.show(target, cancelOrderScreen(order, issue));
        }
        try {
          await this.coordination.decide({ publicId: action.publicId, userId: identity.userId }, action.issueId, {
            version: action.version, action: action.action,
          });
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === 409)
            await this.decisionCard(target, identity, action.publicId, 0, 'Ситуация изменилась. Ниже — актуальные данные; проверьте их перед ответом.');
          throw error;
        }
        await this.cancel(identity);
        const feedback = {
          ACCEPT_ACTUAL: '✅ Фактическое количество принято.',
          REQUEST_REDUCE: 'Запрос передан продавцу. Фактическое количество пока не согласовано.',
          REMOVE_ITEM: 'Товар убран. Остальной заказ сохраняется.',
          ACCEPT_REPLACEMENT: '✅ Замена принята. Продавец продолжит сборку.',
          CANCEL_ORDER: 'Заказ отменён.',
        }[action.action];
        return this.decisionCard(target, identity, action.publicId, action.issueId, feedback);
      }
    }
  }

  async handle(body: unknown) {
    const parsed = customerUpdate.safeParse(body);
    if (!parsed.success) return;
    const callback = parsed.data.callback_query, message = parsed.data.message;
    const chat = callback?.message?.chat ?? message?.chat;
    const from = callback?.from ?? message?.from;
    if (!chat || !from || chat.type !== 'private' || chat.id !== from.id) return;
    await serialUpdate('customer', chat.id, parsed.data.update_id,
      () => this.process(parsed.data));
  }
  private async process(update: ReturnType<typeof customerUpdate.parse>) {
    const { message, callback_query: callback } = update;
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
        command === '/messages' ? {kind:'attention' as const, page: 0} : null;
      if (callback && !action && !shopping) { ack = 'Некорректная кнопка'; return; }
      const identity = command === '/start' ? await this.start(sender) :
        await this.db.telegramIdentity.findUnique({
          where: { telegramUserId: BigInt(sender.id) }, select: identitySelect,
        });
      if (!identity) {
        await this.show(target, { text: 'Нажмите /start, чтобы открыть меню и начать покупки.', keyboard: { inline_keyboard: [] } });
        return;
      }
      if (identity.user.role !== 'USER') {
        this.logger.warn('Customer Telegram identity has a non-customer role');
        await this.show(target, { text: 'Этот аккаунт недоступен в покупательском боте.', keyboard: { inline_keyboard: [] } });
        return;
      }
      if (message?.contact) {
        if (message.contact.user_id !== sender.id) {
          if (!identity.phoneVerified || !identity.phoneNumber) await this.requestPhone(chat.id, true);
          return;
        }
        let updated: Identity;
        try {
          updated = await this.acceptContact(identity, sender, message.contact.phone_number);
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === 400) {
            await this.requestPhone(chat.id, true);
            return;
          }
          throw error;
        }
        if (updated.user.role !== 'USER') return;
        await this.cancel(updated);
        await this.removeContactKeyboard(chat.id);
        await this.menu({ chatId: chat.id }, updated);
        return;
      }
      if (!identity.phoneVerified || !identity.phoneNumber) {
        await this.cancel(identity);
        if (action?.kind === 'menu' || action?.kind === 'cancel')
          await this.show(target, customerOnboardingMenu(identity));
        else if (shopping && ['catalog', 'categories', 'products', 'product', 'open', 'details', 'help'].includes(shopping.kind))
          await this.shop.handle(target, identity, shopping, true);
        else await this.requestPhone(chat.id);
        return;
      }
      if (shopping?.kind === 'resume') await this.resume(target, identity);
      else if (shopping) {
        if (shopping.kind !== 'checkout' && shopping.kind !== 'flow') await this.cancel(identity);
        const displayed = await this.shop.handle(target, identity, shopping);
        if (displayed === false) ack = 'Не удалось обновить экран. /cart — актуальная корзина.';
      }
      else if (extra) await this.action(target, identity, extra);
      else if (action) await this.action(target, identity, action);
      else if (message?.text && !message.text.startsWith('/'))
        await this.reply({ chatId: chat.id }, identity, message.text, message.reply_to_message?.message_id);
      else if (message?.text) await this.show(target, { text: 'Команда не найдена. Откройте меню или помощь, чтобы продолжить.',
        keyboard: { inline_keyboard: [[{ text: 'Меню', callback_data: 'menu' }, { text: 'Помощь', callback_data: 'help' }]] } });
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
