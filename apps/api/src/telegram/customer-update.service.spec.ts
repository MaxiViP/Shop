import { randomUUID } from 'node:crypto';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { CoordinationService } from '../order/coordination.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerShopService } from './customer-shop.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerUpdateService } from './customer-update.service.js';
import { customerDecision, customerConfirmCancellation, customerView } from './customer-callback.js';

const telegramId = 12345;
const publicId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const order = {
  id: 1, publicId, type: 'PICKUP', status: 'ASSEMBLING', subtotal: 12345, total: 12345,
  finalSubtotal: null, finalTotal: null, payment: null, delivery: null,
  items: [], extras: [], createdAt: new Date('2026-09-22T09:00:00Z'), customerUnread: 0, issues: [],
};
const message = (text: string, id = telegramId, type = 'private', replyId?: number) => ({
  message: { message_id: 10, text, from: { id, is_bot: false }, chat: { id, type },
    ...(replyId ? { reply_to_message: { message_id: replyId } } : {}) },
});
const callback = (data: string, id = telegramId, type = 'private') => ({
  callback_query: { id: 'ack', data, from: { id, is_bot: false },
    message: { message_id: 55, chat: { id, type } } },
});
const contact = (number: string, userId: number | null = telegramId) => ({
  message: { message_id: 11, contact: { phone_number: number, ...(userId !== null ? { user_id: userId } : {}) },
    from: { id: telegramId, is_bot: false }, chat: { id: telegramId, type: 'private' } },
});
const fetcher = vi.fn<typeof fetch>();
function setup(linked = true) {
  const db = {
    telegramIdentity: {
      findUnique: vi.fn().mockResolvedValue(linked ? {
        id: 3, userId: 7, firstName: 'Maksim', phoneNumber: '+79990000003', phoneVerified: true,
        user: { name: 'Maksim', role: 'USER' },
      } : null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 3, userId: 7, firstName: 'Maksim', phoneNumber: null, phoneVerified: false,
        user: { name: 'Maksim', role: 'USER' },
      }),
      update: vi.fn().mockResolvedValue({
        id: 3, userId: 7, firstName: 'Maksim', phoneNumber: '+79990000003', phoneVerified: true,
        user: { name: 'Maksim', role: 'USER' },
      }),
      create: vi.fn().mockResolvedValue({
        id: 3, userId: 7, firstName: 'Maksim', phoneNumber: '+79990000003', phoneVerified: true,
        user: { name: 'Maksim', role: 'USER' },
      }),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([order]),
      findFirst: vi.fn().mockResolvedValue(order),
    },
    customerTelegramSession: {
      findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 3 }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  const orders = { get: vi.fn(async (id: string) => { if (id === foreignId) throw new NotFoundException(); return order; }) };
  const coordination = {
    view: vi.fn().mockResolvedValue({ issues: [] }), decide: vi.fn().mockResolvedValue({}),
    messages: vi.fn().mockResolvedValue({ messages: [], hasMore: false, orderId: 1 }), read: vi.fn().mockResolvedValue({ unread: 0 }),
    post: vi.fn().mockResolvedValue({ id: 80 }), reserveReply: vi.fn().mockResolvedValue({ id: 'reservation', orderId: 1 }),
  };
  const shop = {handle: vi.fn(), present: vi.fn(), cartLabel: vi.fn().mockResolvedValue('🛒 Корзина · 2 поз. · ≈ 320 ₽')};
  const checkout = {resume: vi.fn().mockResolvedValue(null)};
  const service = new CustomerUpdateService(db as unknown as DbService,
    coordination as unknown as CoordinationService, orders as unknown as OrderService,
    shop as unknown as CustomerShopService, checkout as unknown as CustomerCheckoutService);
  return { db, service, coordination, orders, shop, checkout };
}
type TelegramBody = { text?: string; callback_query_id?: string; message_id?: number;
  reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>>;
    keyboard?: Array<Array<{ text: string; request_contact?: boolean }>>; remove_keyboard?: boolean; force_reply?: boolean } };
const sent = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as TelegramBody);
const pendingIssue = (id: number, version = 1) => ({
  id, orderItemId: id, version, status: 'WAITING_CUSTOMER', type: 'WEIGHT_DEVIATION',
  requestedQty: 1000, actualQty: 1200,
  orderItem: { productName: 'Товар ' + id, unit: 'GRAM', price: 10000, priceQty: 1000 },
  actions: ['ACCEPT_ACTUAL', 'REQUEST_REDUCE', 'REMOVE_ITEM'],
});

beforeEach(() => {
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID());
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 99 } }));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('customer cabinet', () => {
  it('/start activates exactly the linked identity and presents the menu', async () => {
    const { db, service } = setup();
    await service.handle(message('/start'));
    expect(db.telegramIdentity.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { telegramUserId: BigInt(telegramId) } }));
    expect(db.telegramIdentity.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 3 }, data: { customerBotStartedAt: expect.any(Date), customerBotBlockedAt: null },
    }));
    expect(sent()[0]?.text).toContain('Привет, Maksim!');
    const buttons = sent()[0]?.reply_markup?.inline_keyboard?.flat();
    expect(buttons?.map(button => button.callback_data)).toEqual(expect.arrayContaining(['current', 'orders', 'attention']));
    expect(buttons?.map(button => button.web_app?.url)).toContain('https://shop.example/telegram?returnTo=%2Fprofile');
    expect(buttons?.map(button => button.web_app?.url)).toContain('https://shop.example/telegram?returnTo=%2Fcatalog');
    expect(buttons?.[0]).toMatchObject({ callback_data: 'attention', style: 'primary' });
    expect(buttons?.find(button => button.web_app?.url.includes('%2Fquick-shop'))).toEqual({ text: '⚡ Быстрые покупки / Повторить заказ',
      web_app: { url: 'https://shop.example/telegram?returnTo=%2Fquick-shop' } });
    expect(buttons?.find(button => button.callback_data === 'cart')?.text).toBe('🛒 Корзина · 2 поз. · ≈ 320 ₽');
    expect(buttons?.map(button => button.url).filter(Boolean)).toEqual([]);
  });
  it('/menu does not alter activation and hides irrelevant attention button', async () => {
    const { db, service } = setup();
    db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await service.handle(message('/menu'));
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(JSON.stringify(sent())).not.toContain('attention');
    expect(db.customerTelegramSession.deleteMany).toHaveBeenCalledWith({ where: { identityId: 3 } });
    expect(db.customerTelegramSession.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]!);
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data)).toContain('catalog');
  });
  it('inline Menu cancels input and edits the prompt into the canonical home screen', async () => {
    const { db, service } = setup();
    await service.handle(callback('menu'));
    expect(db.customerTelegramSession.deleteMany).toHaveBeenCalledWith({ where: { identityId: 3 } });
    expect(sent()[0]?.message_id).toBe(55);
    expect(sent()[0]?.text).toContain('Привет, Maksim!');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
      .toEqual(expect.arrayContaining(['catalog', 'cart', 'orders', 'help']));
  });
  it('first /start creates USER and offers public browsing before requesting a self-contact', async () => {
    const { db, service, shop } = setup(false);
    db.telegramIdentity.create.mockResolvedValueOnce({
      id: 3, userId: 7, firstName: 'Maksim', phoneNumber: null, phoneVerified: false,
      user: { name: 'Maksim', role: 'USER' },
    });
    await service.handle({ message: { ...message('/start').message,
      from: { id: telegramId, is_bot: false, username: 'buyer',
        first_name: 'Maksim', last_name: 'Buyer' },
    } });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.telegramIdentity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        telegramUserId: BigInt(telegramId), username: 'buyer', firstName: 'Maksim',
        lastName: 'Buyer', customerBotStartedAt: expect.any(Date), customerBotBlockedAt: null,
        user: { create: { role: 'USER', phone: null, name: 'Maksim Buyer' } },
      },
    }));
    expect(sent()[0]?.text).toContain('Посмотрите продукты и цены в каталоге');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
      .toEqual(expect.arrayContaining(['catalog', 'verify_phone', 'help']));
    expect(sent()[0]?.reply_markup?.keyboard).toBeUndefined();
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(shop.handle).not.toHaveBeenCalled();
  });
  it('valid self-contact is normalized, removes the keyboard, then opens the inline menu', async () => {
    const { db, service } = setup();
    db.telegramIdentity.findUnique.mockResolvedValueOnce({
      id: 3, userId: 7, firstName: 'Maksim', phoneNumber: null, phoneVerified: false,
      user: { name: 'Maksim', role: 'USER' },
    });
    await service.handle(contact('8 (999) 123-45-67'));
    expect(db.telegramIdentity.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 3 }, data: { phoneNumber: '+79991234567', phoneVerified: true },
    }));
    expect(sent()[0]?.reply_markup?.remove_keyboard).toBe(true);
    expect(sent()[1]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
      .toEqual(expect.arrayContaining(['catalog', 'cart', 'orders', 'help']));
  });
  it('foreign or missing contact user_id cannot verify a phone or enter shopping', async () => {
    const { db, service, shop } = setup();
    const missingPhone = {
      id: 3, userId: 7, firstName: 'Maksim', phoneNumber: null, phoneVerified: false,
      user: { name: 'Maksim', role: 'USER' },
    };
    db.telegramIdentity.findUnique.mockResolvedValue(missingPhone);
    await service.handle(contact('+79991234567', telegramId + 1));
    await service.handle(contact('+79991234567', null));
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(shop.handle).not.toHaveBeenCalled();
    expect(sent().filter(body => body.reply_markup?.keyboard)).toHaveLength(2);
  });
  it('invalid self-contact is not stored and requests a usable phone again', async () => {
    const { db, service } = setup();
    db.telegramIdentity.findUnique.mockResolvedValueOnce({
      id: 3, userId: 7, firstName: 'Maksim', phoneNumber: null, phoneVerified: false,
      user: { name: 'Maksim', role: 'USER' },
    });
    await service.handle(contact('invalid'));
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(sent()[0]?.reply_markup?.keyboard?.[0]?.[0]?.request_contact).toBe(true);
  });
  it('existing no-phone user is prompted on the next shopping action', async () => {
    const { db, service, shop } = setup();
    db.telegramIdentity.findUnique.mockResolvedValue({
      id: 3, userId: 7, firstName: 'Maksim', phoneNumber: null, phoneVerified: false,
      user: { name: 'Maksim', role: 'USER' },
    });
    await service.handle(message('/cart'));
    expect(shop.handle).not.toHaveBeenCalled();
    expect(sent()[0]?.reply_markup?.keyboard?.[0]?.[0]?.request_contact).toBe(true);
  });
  it('verified Telegram phone skips the contact prompt', async () => {
    const { service, shop } = setup();
    await service.handle(message('/cart'));
    expect(shop.handle).toHaveBeenCalledOnce();
    expect(sent().some(body => body.reply_markup?.keyboard)).toBe(false);
  });
  it.each(['ADMIN', 'SELLER'])('does not activate an existing %s account', async role => {
    const { db, service } = setup();
    db.telegramIdentity.findUnique.mockResolvedValue({
      id: 3, userId: 7, firstName: 'Staff', user: { name: 'Staff', role },
    });
    await service.handle(message('/start'));
    expect(db.telegramIdentity.create).not.toHaveBeenCalled();
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(db.order.findFirst).not.toHaveBeenCalled();
    expect(sent()[0]?.text).toContain('аккаунт недоступен');
  });
  it('/orders uses a bounded owned query and public display labels', async () => {
    const { db, service } = setup();
    await service.handle(message('/orders'));
    expect(db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 7 }, take: 6, skip: 0 }));
    expect(sent()[0]?.text).toContain('123,45');
    expect(sent()[0]?.text).toContain('№1');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(customerView('o', publicId));
  });
  it('paginates order lists without unbounded queries', async () => {
    const { db, service } = setup();
    await service.handle(callback('c:l:2'));
    expect(db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 6 }));
  });
  it('current order is owner-bound and uses the shared OrderService', async () => {
    const { db, service, orders } = setup();
    await service.handle(callback('current'));
    expect(db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7, status: { in: ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'] } },
    }));
    expect(orders.get).toHaveBeenCalledWith(publicId, 7);
    expect(sent().at(-1)?.callback_query_id).toBe('ack');
  });
  it('handles absent current order', async () => {
    const { db, service } = setup();
    db.order.findFirst.mockResolvedValueOnce(null);
    await service.handle(callback('current'));
    expect(sent()[0]?.text).toContain('нет текущих');
  });
  it('preserves old order callbacks, uses owned domain reads and edits the message', async () => {
    const { service, coordination, orders } = setup();
    await service.handle(callback('order:' + publicId));
    expect(orders.get).toHaveBeenCalledWith(publicId, 7);
    expect(coordination.view).not.toHaveBeenCalled();
    expect(sent()[0]?.message_id).toBe(55);
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().find(button => button.text === 'Открыть заказ на сайте')?.web_app?.url)
      .toBe('https://shop.example/telegram?returnTo=' + encodeURIComponent('/order/' + publicId));
    expect(sent()[0]?.text).toContain('Заказ №1');
  });
  it('uses CoordinationService only for the versioned issue screen', async () => {
    const { service, coordination } = setup();
    await service.handle(callback(customerView('q', publicId)));
    expect(coordination.view).toHaveBeenCalledWith({ publicId, userId: 7 });
  });
  it('foreign order reveals no order data', async () => {
    const { service, coordination } = setup();
    await service.handle(callback('order:' + foreignId));
    expect(coordination.view).not.toHaveBeenCalled();
    expect(sent()).toEqual([{ callback_query_id: 'ack', text: 'Заказ недоступен', cache_time: 0 }]);
  });
  it.each(['group', 'supergroup', 'channel'])('ignores %s for messages and callbacks', async type => {
    const { db, service } = setup();
    await service.handle(message('/orders', telegramId, type));
    await service.handle(callback('orders', telegramId, type));
    expect(db.telegramIdentity.findUnique).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects actor/chat mismatch, bots and ambiguous updates', async () => {
    const { db, service } = setup();
    await service.handle({ message: { ...message('/orders').message, chat: { id: 999, type: 'private' } } });
    await service.handle({ message: { ...message('/orders').message, from: { id: telegramId, is_bot: true } } });
    await service.handle({ ...message('/orders'), ...callback('orders') });
    expect(db.telegramIdentity.findUnique).not.toHaveBeenCalled();
  });
  it.each(['order:garbage', 'staff:1', 'c:d:bad', 'x'.repeat(65)])('safely ACKs malformed callback %s', async data => {
    const { service, coordination } = setup();
    await service.handle(callback(data));
    expect(coordination.decide).not.toHaveBeenCalled();
    expect(sent().at(-1)?.text).toBe('Некорректная кнопка');
  });
  it.each([
    ['a', 'ACCEPT_ACTUAL'], ['r', 'REQUEST_REDUCE'], ['x', 'REMOVE_ITEM'],
    ['p', 'ACCEPT_REPLACEMENT'],
  ] as const)('routes %s through CoordinationService with exact issue version and customer actor', async (code, action) => {
    const { service, coordination } = setup();
    await service.handle(callback(customerDecision(publicId, 8, 3, code)));
    expect(coordination.decide).toHaveBeenCalledWith({ publicId, userId: 7 }, 8, { version: 3, action });
  });
  it('stale issue gets a friendly ACK without retrying mutation', async () => {
    const { service, coordination, db } = setup();
    coordination.decide.mockRejectedValueOnce(new ConflictException());
    await service.handle(callback(customerDecision(publicId, 8, 2, 'a')));
    expect(coordination.decide).toHaveBeenCalledTimes(1);
    expect(db.customerTelegramSession.deleteMany).not.toHaveBeenCalled();
    expect(sent().at(-1)?.text).toContain('уже изменилась');
  });
  it('moves directly to the next freshly read unresolved question after a decision', async () => {
    const { service, coordination, orders } = setup();
    coordination.view.mockResolvedValue({ issues: [
      { ...pendingIssue(8, 3), status: 'RESOLVED', actions: [] }, pendingIssue(9, 7), pendingIssue(12, 2),
    ] });
    await service.handle(callback(customerDecision(publicId, 8, 3, 'a')));
    expect(coordination.decide).toHaveBeenCalledOnce();
    expect(coordination.decide).toHaveBeenCalledWith({ publicId, userId: 7 }, 8, { version: 3, action: 'ACCEPT_ACTUAL' });
    expect(coordination.view).toHaveBeenCalledWith({ publicId, userId: 7 });
    expect(orders.get).toHaveBeenCalledWith(publicId, 7);
    expect(sent()[0]?.text).toContain('✅ Фактическое количество принято.');
    expect(sent()[0]?.text).toContain('Товар 9');
    const buttons = sent()[0]?.reply_markup?.inline_keyboard?.flat();
    expect(buttons?.some(button => button.callback_data === customerDecision(publicId, 9, 7, 'a'))).toBe(true);
    expect(buttons?.some(button => button.callback_data === customerDecision(publicId, 8, 3, 'a'))).toBe(false);
  });
  it('requests reduction without accepting the weight or canceling the order, then shows the next question', async () => {
    const { service, coordination } = setup();
    coordination.view.mockResolvedValue({ issues: [
      { ...pendingIssue(8, 3), status: 'WAITING_SELLER', actions: [] }, pendingIssue(12, 4),
    ] });
    await service.handle(callback(customerDecision(publicId, 8, 3, 'r')));
    expect(coordination.decide).toHaveBeenCalledOnce();
    expect(coordination.decide).toHaveBeenCalledWith({ publicId, userId: 7 }, 8, { version: 3, action: 'REQUEST_REDUCE' });
    expect(sent()[0]?.text).toContain('пока не согласовано');
    expect(sent()[0]?.text).toContain('Товар 12');
    expect(sent()[0]?.text).not.toContain('Заказ отменён');
    expect(sent()[0]?.text).not.toContain('Фактическое количество принято');
  });
  it('removes only the selected item and returns to the owned order when no questions remain', async () => {
    const { service, coordination, orders } = setup();
    await service.handle(callback(customerDecision(publicId, 8, 3, 'x')));
    expect(coordination.decide).toHaveBeenCalledWith({ publicId, userId: 7 }, 8, { version: 3, action: 'REMOVE_ITEM' });
    expect(orders.get).toHaveBeenCalledWith(publicId, 7);
    expect(sent()[0]?.text).toContain('Товар убран. Остальной заказ сохраняется.');
    expect(sent()[0]?.text).toContain('Заказ №1 · Собирается');
    expect(sent()[0]?.text).not.toContain('Заказ отменён');
  });
  it('refreshes a stale issue to its current version without replaying the rejected mutation', async () => {
    const { service, coordination, db } = setup();
    coordination.decide.mockRejectedValueOnce(new ConflictException());
    coordination.view.mockResolvedValue({ issues: [pendingIssue(8, 4)] });
    await service.handle(callback(customerDecision(publicId, 8, 2, 'a')));
    expect(coordination.decide).toHaveBeenCalledOnce();
    expect(db.customerTelegramSession.deleteMany).not.toHaveBeenCalled();
    expect(sent()[0]?.text).toContain('актуальные данные');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().some(button =>
      button.callback_data === customerDecision(publicId, 8, 4, 'a'))).toBe(true);
    expect(sent().at(-1)?.text).toContain('уже изменилась');
  });
  it('wraps to an earlier unresolved question rather than displaying resolved or seller-waiting rows', async () => {
    const { service, coordination } = setup();
    coordination.view.mockResolvedValue({ issues: [
      pendingIssue(3, 5), { ...pendingIssue(8), status: 'WAITING_SELLER', actions: [] },
      { ...pendingIssue(12), status: 'RESOLVED', actions: [] },
    ] });
    await service.handle(callback(customerDecision(publicId, 12, 1, 'p')));
    expect(sent()[0]?.text).toContain('Замена принята');
    expect(sent()[0]?.text).toContain('Товар 3');
    expect(sent()[0]?.text).not.toContain('Товар 8');
  });
  it('chat pages reuse messages/read and read only after a successful display', async () => {
    const { service, coordination } = setup();
    coordination.messages.mockResolvedValue({ messages: [{ id: 20, text: 'Добрый день', authorType: 'SELLER', createdAt: new Date() }], hasMore: true, orderId: 1 });
    await service.handle(callback(customerView('m', publicId)));
    expect(coordination.messages).toHaveBeenCalledWith({ publicId, userId: 7 }, { limit: 1 });
    expect(coordination.read).toHaveBeenCalledWith({ publicId, userId: 7 }, 20);
    expect(sent()[0]?.text).toContain('Заказ №1 · Сообщения');
    coordination.read.mockClear();
    fetcher.mockRejectedValueOnce(new Error('unavailable'));
    await service.handle(callback(customerView('m', publicId)));
    expect(coordination.read).not.toHaveBeenCalled();
  });
  it('a malformed successful display response cannot acknowledge unread chat messages', async () => {
    const { service, coordination } = setup();
    coordination.messages.mockResolvedValue({ messages: [{ id: 20, text: 'Fixture', authorType: 'SELLER', createdAt: new Date() }], hasMore: false, orderId: 1 });
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await service.handle(callback(customerView('m', publicId)));
    expect(coordination.read).not.toHaveBeenCalled();
    expect(vi.mocked(Logger.prototype.warn)).toHaveBeenCalledWith('Customer Telegram display failed');
  });
  it('sends an inline reply prompt with navigation and binds the exact reply message ID', async () => {
    const { service, coordination, db } = setup();
    await service.handle(callback(customerView('w', publicId)));
    expect(coordination.reserveReply).toHaveBeenCalledWith({ publicId, userId: 7 }, 3);
    expect(sent()[0]?.reply_markup?.force_reply).toBe(true);
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data)).toEqual(['cancel', 'menu']);
    expect(JSON.stringify(sent())).not.toContain('"keyboard"');
    expect(sent()[0]?.text).toContain('заказу №1');
    expect(db.customerTelegramSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'reservation', identityId: 3, action: 'CHAT', step: 'PROMPT', promptMessageId: null, expiresAt: { gt: expect.any(Date) } },
      data: { step: 'TEXT', promptMessageId: 99 },
    });
  });
  it('only forwards matching persisted replies to the atomic domain claim', async () => {
    const { service, coordination, db } = setup();
    db.customerTelegramSession.findUnique.mockResolvedValue({
      id: 'saved', action: 'CHAT', step: 'TEXT', promptMessageId: 99, expiresAt: new Date(Date.now() + 60000),
      order: { publicId, userId: 7 },
    });
    await service.handle(message('Сообщение', telegramId, 'private', 98));
    expect(coordination.post).not.toHaveBeenCalled();
    await service.handle(message('Сообщение', telegramId, 'private', 99));
    expect(coordination.post).toHaveBeenCalledWith({ publicId, userId: 7 }, 'Сообщение',
      { sessionId: 'saved', identityId: 3, promptMessageId: 99 });
  });
  it('expired or foreign-order pending input never posts', async () => {
    const { service, coordination, db } = setup();
    db.customerTelegramSession.findUnique.mockResolvedValue({
      id: 'saved', step: 'TEXT', promptMessageId: 99, expiresAt: new Date(0), order: { publicId, userId: 7 },
    });
    await service.handle(message('Текст', telegramId, 'private', 99));
    expect(db.customerTelegramSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'saved' } });
    db.customerTelegramSession.findUnique.mockResolvedValue({
      id: 'saved', step: 'TEXT', promptMessageId: 99, expiresAt: new Date(Date.now() + 60000), order: { publicId, userId: 9 },
    });
    await service.handle(message('Текст', telegramId, 'private', 99));
    expect(coordination.post).not.toHaveBeenCalled();
  });
  it('/cancel removes pending input without changing any order', async () => {
    const { service, coordination, db } = setup();
    await service.handle(message('/cancel'));
    expect(db.customerTelegramSession.deleteMany).toHaveBeenCalledWith({ where: { identityId: 3 } });
    expect(coordination.post).not.toHaveBeenCalled();
    expect(coordination.decide).not.toHaveBeenCalled();
    expect(sent()[0]?.text).toContain('Привет, Maksim!');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data)).toContain('catalog');
  });
  it('does not log provider bodies, customer data or credentials', async () => {
    const { service } = setup();
    const token = process.env.TELEGRAM_CUSTOMER_BOT_TOKEN!;
    fetcher.mockRejectedValue(new Error('provider body ' + token + publicId + ' Maksim ' + telegramId));
    await service.handle(message('/menu'));
    const logs = JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls);
    for (const secret of [token, publicId, 'Maksim', String(telegramId), 'provider body']) expect(logs).not.toContain(secret);
  });
});

describe('shopping command routing and unknown chat delivery', () => {
  it.each(['catalog','cart','help'])('routes /%s only after server identity lookup',async kind=>{
    const {service,shop}=setup();
    await service.handle(message('/'+kind));
    expect(shop.handle).toHaveBeenCalledWith({chatId:telegramId},
      expect.objectContaining({id:3,userId:7}),{kind});
  });
  it('unlinked shopper never reaches shopping/cart services',async()=>{
    const {service,shop}=setup(false);
    await service.handle(message('/cart'));
    expect(shop.handle).not.toHaveBeenCalled();
  });
  it('/resume with no session shows an actionable state',async()=>{
    const {service,checkout}=setup();
    await service.handle(message('/resume'));
    expect(checkout.resume).toHaveBeenCalledWith(expect.objectContaining({id:3,userId:7}));
    expect(sent()[0]?.text).toContain('Нет незавершённого');
  });
  it.each(['throw','malformed','missing-id'])('unknown chat prompt %s never deletes the reservation',async mode=>{
    const {service,db}=setup();
    if(mode==='throw') fetcher.mockRejectedValueOnce(new Error('transport fixture'));
    else fetcher.mockResolvedValueOnce(mode==='malformed'?new Response('invalid'):Response.json({ok:true,result:{}}));
    await service.handle(callback(customerView('w',publicId)));
    expect(db.customerTelegramSession.deleteMany).not.toHaveBeenCalled();
    expect(db.customerTelegramSession.updateMany).not.toHaveBeenCalled();
  });
});


describe('customer premium flows', () => {
  it('asks before canceling the whole order, including legacy cancellation buttons', async () => {
    const { service, coordination, orders } = setup();
    coordination.view.mockResolvedValue({ issues: [{ ...pendingIssue(8, 3), actions: ['CANCEL_ORDER'] }] });
    await service.handle(callback(customerDecision(publicId, 8, 3, 'c')));
    expect(coordination.decide).not.toHaveBeenCalled();
    expect(orders.get).toHaveBeenCalledWith(publicId, 7);
    expect(sent()[0]?.text).toContain('Отменить весь заказ №1?');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
      .toContain(customerConfirmCancellation(publicId, 8, 3));
  });
  it('passes confirmed cancellation through the domain ownership/version check exactly once', async () => {
    const { service, coordination } = setup();
    await service.handle(callback(customerConfirmCancellation(publicId, 8, 3)));
    expect(coordination.decide).toHaveBeenCalledOnce();
    expect(coordination.decide).toHaveBeenCalledWith({ publicId, userId: 7 }, 8, { version: 3, action: 'CANCEL_ORDER' });
  });
  it.each(['version', 'resolved', 'notAllowed'])('never offers confirmation for a stale %s issue', async change => {
    const { service, coordination } = setup();
    const issue = { ...pendingIssue(8, 3), actions: ['CANCEL_ORDER'] };
    if (change === 'version') issue.version = 4;
    if (change === 'resolved') issue.status = 'RESOLVED';
    if (change === 'notAllowed') issue.actions = [];
    coordination.view.mockResolvedValue({ issues: [issue] });
    await service.handle(callback(customerDecision(publicId, 8, 3, 'c')));
    expect(coordination.decide).not.toHaveBeenCalled();
    expect(sent()[0]?.text).toContain('Ситуация изменилась');
    expect(JSON.stringify(sent())).not.toContain(customerConfirmCancellation(publicId, 8, 3));
  });
  it('does not replay a confirmed cancellation rejected because its version changed', async () => {
    const { service, coordination } = setup();
    coordination.decide.mockRejectedValueOnce(new ConflictException());
    await service.handle(callback(customerConfirmCancellation(publicId, 8, 3)));
    expect(coordination.decide).toHaveBeenCalledOnce();
    expect(sent().at(-1)?.text).toContain('уже изменилась');
  });
  it('paginates attention beyond the first five orders and keeps the filter', async () => {
    const { service, db } = setup();
    db.order.findMany.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ ...order, id: i + 10 })));
    await service.handle(callback('attention'));
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data)).toContain('c:n:1');
    await service.handle(callback('c:n:1'));
    expect(db.order.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 7, OR: expect.any(Array) }), skip: 5, take: 6,
    }));
    expect(sent()[2]?.text).toContain('страница 2');
    expect(sent()[2]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data)).toContain('c:n:0');
  });
  it('opens the oldest unread message instead of acknowledging unseen older messages', async () => {
    const { service, coordination } = setup();
    const oldest = { id: 20, text: 'Первое непрочитанное', authorType: 'SELLER', createdAt: new Date() };
    coordination.messages.mockResolvedValue({ messages: [{ ...oldest, id: 30, text: 'Последнее' }],
      unreadMessage: oldest, hasMore: true, orderId: 1 });
    await service.handle(callback(customerView('m', publicId)));
    expect(sent()[0]?.text).toContain('Первое непрочитанное');
    expect(sent()[0]?.text).not.toContain('Последнее');
    expect(coordination.read).toHaveBeenCalledWith({ publicId, userId: 7 }, 20);
  });
  it('does not mark skipped earlier unread messages as read when the customer opens the latest', async () => {
    const { service, coordination } = setup();
    const entry = { id: 20, text: 'Ранее', authorType: 'SELLER', createdAt: new Date() };
    coordination.messages.mockResolvedValue({ messages: [{ ...entry, id: 30, text: 'Новое' }],
      unreadMessage: entry, hasMore: true, orderId: 1 });
    await service.handle(callback(customerView('t', publicId)));
    expect(sent()[0]?.text).toContain('Новое');
    expect(sent()[0]?.text).toContain('более ранние непрочитанные');
    expect(coordination.read).not.toHaveBeenCalled();
  });
  it('navigates forward using the bounded server cursor', async () => {
    const { service, coordination } = setup();
    await service.handle(callback(customerView('n', publicId, 21)));
    expect(coordination.messages).toHaveBeenCalledWith({ publicId, userId: 7 }, { limit: 1, after: 21 });
    expect(sent()[0]?.text).toContain('Больше сообщений');
  });
  it('opens the exact photo through the owned order without acknowledging an unseen revision', async () => {
    const { service, coordination } = setup();
    const image = { id: 12, text: 'Исходная подпись', revisionText: 'Новая подпись', image: true,
      authorType: 'SELLER', createdAt: new Date() };
    coordination.messages.mockResolvedValue({ messages: [], unreadMessage: null, readThrough: 30,
      unreadRevision: { id: 6, messageId: 12, version: 1, message: image }, hasMore: false, orderId: 1 });
    await service.handle(callback(customerView('m', publicId)));
    expect(sent()[0]?.text).toContain('Новая подпись');
    expect(sent()[0]?.text).toContain('Просмотр фото на сайте снимет индикатор');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().find(button => button.text.includes('Открыть фото'))?.web_app?.url)
      .toBe('https://shop.example/telegram?returnTo=' + encodeURIComponent('/order/' + publicId + '?chatMessage=12#order-chat'));
    expect(coordination.read).not.toHaveBeenCalled();
  });
  it.each(['catalog', 'help', 's:c:0', 's:l:1:0', 's:v:1:1'])(
    'allows public %s before phone verification without fetching private orders or cart', async data => {
      const { service, db, shop } = setup();
      db.telegramIdentity.findUnique.mockResolvedValueOnce({ id: 3, userId: 7, firstName: 'Maksim',
        phoneNumber: null, phoneVerified: false, user: { name: 'Maksim', role: 'USER' } });
      await service.handle(callback(data));
      expect(shop.handle).toHaveBeenCalledWith({ chatId: telegramId, messageId: 55 },
        expect.objectContaining({ id: 3, userId: 7 }), expect.any(Object), true);
      expect(db.order.findFirst).not.toHaveBeenCalled();
      expect(db.order.findMany).not.toHaveBeenCalled();
      expect(shop.cartLabel).not.toHaveBeenCalled();
    },
  );
  it.each(['cart', 'orders', 'current', 'attention', customerView('o', publicId), 's:a:' + publicId.replaceAll('-', '') + ':1:1',
    's:b:' + publicId.replaceAll('-', ''), customerConfirmCancellation(publicId, 8, 3)])(
    'requires a verified own phone for private or mutating %s', async data => {
      const { service, db, shop, orders, coordination } = setup();
      db.telegramIdentity.findUnique.mockResolvedValueOnce({ id: 3, userId: 7, firstName: 'Maksim',
        phoneNumber: null, phoneVerified: false, user: { name: 'Maksim', role: 'USER' } });
      await service.handle(callback(data));
      expect(shop.handle).not.toHaveBeenCalled();
      expect(orders.get).not.toHaveBeenCalled();
      expect(coordination.decide).not.toHaveBeenCalled();
      expect(sent()[0]?.reply_markup?.keyboard?.[0]?.[0]).toEqual({ text: 'Поделиться номером', request_contact: true });
    },
  );
  it('requests the self-contact explicitly from the onboarding button', async () => {
    const { service, db } = setup();
    db.telegramIdentity.findUnique.mockResolvedValueOnce({ id: 3, userId: 7, firstName: 'Maksim',
      phoneNumber: null, phoneVerified: false, user: { name: 'Maksim', role: 'USER' } });
    await service.handle(callback('verify_phone'));
    expect(sent()[0]?.reply_markup?.keyboard?.[0]?.[0]?.request_contact).toBe(true);
  });
  it('recovers an unknown command with menu and help', async () => {
    const { service } = setup();
    await service.handle(message('/unknown'));
    expect(sent()[0]?.text).toContain('Команда не найдена');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data)).toEqual(['menu', 'help']);
  });
});
