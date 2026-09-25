import { randomUUID } from 'node:crypto';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { CoordinationService } from '../order/coordination.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerShopService } from './customer-shop.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerUpdateService } from './customer-update.service.js';
import { customerDecision, customerView } from './customer-callback.js';

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
const fetcher = vi.fn<typeof fetch>();
function setup(linked = true) {
  const db = {
    telegramIdentity: {
      findUnique: vi.fn().mockResolvedValue(linked ? {
        id: 3, userId: 7, firstName: 'Maksim', user: { name: 'Maksim' },
      } : null),
      update: vi.fn().mockResolvedValue({}),
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
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  const orders = { get: vi.fn(async (id: string) => { if (id === foreignId) throw new NotFoundException(); return order; }) };
  const coordination = {
    view: vi.fn().mockResolvedValue({ issues: [] }), decide: vi.fn().mockResolvedValue({}),
    messages: vi.fn().mockResolvedValue({ messages: [], hasMore: false, orderId: 1 }), read: vi.fn().mockResolvedValue({ unread: 0 }),
    post: vi.fn().mockResolvedValue({ id: 80 }), reserveReply: vi.fn().mockResolvedValue({ id: 'reservation', orderId: 1 }),
  };
  const shop = {handle: vi.fn(), present: vi.fn()};
  const checkout = {resume: vi.fn().mockResolvedValue(null)};
  const service = new CustomerUpdateService(db as unknown as DbService,
    coordination as unknown as CoordinationService, orders as unknown as OrderService,
    shop as unknown as CustomerShopService, checkout as unknown as CustomerCheckoutService);
  return { db, service, coordination, orders, shop, checkout };
}
type TelegramBody = { text?: string; callback_query_id?: string; message_id?: number;
  reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>>; force_reply?: boolean } };
const sent = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as TelegramBody);

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
    expect(db.telegramIdentity.update).toHaveBeenCalledWith({
      where: { id: 3 }, data: { customerBotStartedAt: expect.any(Date), customerBotBlockedAt: null },
    });
    expect(sent()[0]?.text).toContain('Привет, Maksim!');
    const buttons = sent()[0]?.reply_markup?.inline_keyboard?.flat();
    expect(buttons?.map(button => button.callback_data)).toEqual(expect.arrayContaining(['current', 'orders', 'attention']));
    expect(buttons?.map(button => button.web_app?.url)).toContain('https://shop.example/telegram?returnTo=%2Fprofile');
    expect(buttons?.map(button => button.web_app?.url)).toContain('https://shop.example/telegram?returnTo=%2Fcatalog');
    expect(buttons?.map(button => button.url).filter(Boolean)).toEqual([]);
  });
  it('/menu does not alter activation and hides irrelevant attention button', async () => {
    const { db, service } = setup();
    db.order.findFirst.mockResolvedValueOnce(null);
    await service.handle(message('/menu'));
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(JSON.stringify(sent())).not.toContain('attention');
  });
  it('unlinked user is directed to website login without account creation', async () => {
    const { db, service } = setup(false);
    await service.handle(message('/start'));
    expect(db.telegramIdentity.update).not.toHaveBeenCalled();
    expect(sent()[0]?.text).toContain('войдите через Telegram');
    expect(sent()[0]?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url)
      .toBe('https://shop.example/telegram?returnTo=%2Fcatalog');
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
    ['p', 'ACCEPT_REPLACEMENT'], ['c', 'CANCEL_ORDER'],
  ] as const)('routes %s through CoordinationService with exact issue version and customer actor', async (code, action) => {
    const { service, coordination } = setup();
    await service.handle(callback(customerDecision(publicId, 8, 3, code)));
    expect(coordination.decide).toHaveBeenCalledWith({ publicId, userId: 7 }, 8, { version: 3, action });
  });
  it('stale issue gets a friendly ACK without retrying mutation', async () => {
    const { service, coordination } = setup();
    coordination.decide.mockRejectedValueOnce(new ConflictException());
    await service.handle(callback(customerDecision(publicId, 8, 2, 'a')));
    expect(coordination.decide).toHaveBeenCalledTimes(1);
    expect(sent().at(-1)?.text).toContain('уже изменилась');
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
  it('reserves exact order before sending ForceReply and attaches returned prompt ID', async () => {
    const { service, coordination, db } = setup();
    await service.handle(callback(customerView('w', publicId)));
    expect(coordination.reserveReply).toHaveBeenCalledWith({ publicId, userId: 7 }, 3);
    expect(sent()[0]?.reply_markup?.force_reply).toBe(true);
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
