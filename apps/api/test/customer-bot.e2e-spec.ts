import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type OrderStatus, type NotificationType } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { OrderService } from '../src/order/order.service.js';
import { CoordinationService } from '../src/order/coordination.service.js';
import { message as appendMessage } from '../src/order/coordination.js';
import { NotificationService } from '../src/order/notification.service.js';
import { telegramEvent } from '../src/order/outbox.js';
import { StaffService } from '../src/staff/staff.service.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import { CartService } from '../src/cart/cart.service.js';
import { CustomerCheckoutService } from '../src/telegram/customer-checkout.service.js';
import { CustomerShopService } from '../src/telegram/customer-shop.service.js';
import { CustomerUpdateService } from '../src/telegram/customer-update.service.js';
import { CustomerNotificationService } from '../src/telegram/customer-notification.service.js';
import type { BotDelivery } from '../src/telegram/bot-api.js';
import { customerDecision, customerView } from '../src/telegram/customer-callback.js';

// Migrations and real concurrency in a disposable schema, only on a loopback DB.
describe.skipIf(!process.env.DATABASE_URL)('CUSTOMER v2 PostgreSQL', () => {
  const schema = 'customer_bot_test_' + randomUUID().replaceAll('-', '');
  let connection: pg.Client;
  let db: PrismaClient;
  let created = false;
  let legacyId: number;
  let legacyRows: Record<string, unknown>[];
  let seller: { userId: number; role: 'SELLER' };
  const sms = { available: true, send: vi.fn(async () => {}) };
  const telegram = { available: true, send: vi.fn<() => Promise<BotDelivery>>() };
  const fetcher = vi.fn<typeof fetch>();
  let notices: NotificationService, orders: OrderService, coordination: CoordinationService, staff: StaffService;
  let messageSequence = 100;
  const makeBot = () => {
    const typed = db as unknown as DbService;
    const cart = new CartService(typed, orders);
    const checkout = new CustomerCheckoutService(typed, cart, orders);
    return new CustomerUpdateService(typed, coordination, orders,
      new CustomerShopService(typed, cart, checkout, orders), checkout);
  };
  const callback = (actorId: number, data: string) => ({
    callback_query: { id: 'callback-fixture', data, from: { id: actorId, is_bot: false },
      message: { message_id: 10, chat: { id: actorId, type: 'private' } } },
  });
  const text = (actorId: number, value: string, reply?: number) => ({
    message: { message_id: 30, text: value, from: { id: actorId, is_bot: false },
      chat: { id: actorId, type: 'private' },
      ...(reply ? { reply_to_message: { message_id: reply } } : {}) },
  });

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Local test database required');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    expect(Number((await connection.query('SHOW server_version_num')).rows[0].server_version_num)).toBeGreaterThanOrEqual(120000);
    if (!/^customer_bot_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    await connection.query('SET search_path TO "' + schema + '"');
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20260924120000_customer_bot_v2') {
        const legacy = await connection.query(`INSERT INTO "Order" ("customerName","customerPhone",type,subtotal,"deliveryPrice",total,"updatedAt")
          VALUES ('Legacy fixture','+79990000001','PICKUP',10000,0,10000,NOW()) RETURNING id`);
        const notification = await connection.query(`INSERT INTO "OrderNotification" ("orderId",type,status,"dedupeKey",attempts,error,"updatedAt")
          VALUES ($1,'ACTION_REQUIRED','FAILED','legacy-event',2,'SMS_SEND_FAILED',NOW()) RETURNING id`, [legacy.rows[0].id]);
        legacyId = notification.rows[0].id as number;
        await connection.query(`INSERT INTO "OrderNotification" ("orderId",type,status,"dedupeKey",attempts,"sentAt","updatedAt")
          SELECT $1,'PAYMENT_READY',s::"NotificationStatus",'legacy-' || s,1,
            CASE WHEN s = 'SENT' THEN NOW() ELSE NULL END,NOW()
          FROM unnest(ARRAY['PENDING','SENDING','SENT','UNCONFIGURED','CANCELED']) AS s`, [legacy.rows[0].id]);
        legacyRows = (await connection.query<Record<string, unknown>>('SELECT * FROM "OrderNotification" ORDER BY id')).rows;
      }
      await connection.query(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    }
    db = new PrismaClient({ adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL, options: '-c search_path=' + schema,
    }, { schema }) });
    const typed = db as unknown as DbService;
    notices = new NotificationService(typed, sms, telegram as unknown as CustomerNotificationService);
    orders = new OrderService(typed, { notifyNewOrder: async () => {} } as unknown as TelegramService);
    coordination = new CoordinationService(typed, orders, notices);
    staff = new StaffService(typed, notices);
    const user = await db.user.create({ data: { role: 'SELLER', name: 'Seller fixture' } });
    seller = { userId: user.id, role: 'SELLER' };
  }, 60000);
  beforeEach(() => {
    vi.stubEnv('ORDER_SMS_ENABLED', 'true');
    vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
    vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID());
    sms.available = true; telegram.available = true;
    sms.send.mockReset().mockResolvedValue(undefined);
    telegram.send.mockReset().mockResolvedValue('sent');
    fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: ++messageSequence } }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await db?.$disconnect();
    if (created && /^customer_bot_test_[a-f0-9]{32}$/.test(schema))
      await connection.query('DROP SCHEMA "' + schema + '" CASCADE');
    await connection?.end();
  }, 30000);

  async function fixture(status: OrderStatus = 'ASSEMBLING', linked = true) {
    const user = await db.user.create({ data: { name: 'Customer fixture', phone: null } });
    const telegramId = 400000 + user.id;
    const identity = linked ? await db.telegramIdentity.create({ data: {
      userId: user.id, telegramUserId: BigInt(telegramId), customerBotStartedAt: new Date(),
    } }) : null;
    const order = await db.order.create({ data: {
      userId: user.id, customerName: 'Customer fixture', customerPhone: '+79990000002',
      type: 'PICKUP', status, subtotal: 10000, total: 10000, deliveryPrice: 0,
      items: { create: { productName: 'Томаты', productSlug: 'tomato', unit: 'GRAM', price: 10000, priceQty: 1000, qty: 1000, total: 10000 } },
    }, include: { items: true } });
    return { user, telegramId, identity, order, actor: { publicId: order.publicId, userId: user.id } };
  }
  const events = (orderId: number, type?: NotificationType) => db.orderNotification.findMany({
    where: { orderId, ...(type ? { type } : {}) }, orderBy: { id: 'asc' },
  });
  async function waiting() {
    const f = await fixture();
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PICKED', actualQty: 1200 }, seller.userId, seller);
    const issue = await db.orderIssue.findUniqueOrThrow({ where: { orderItemId: f.order.items[0]!.id } });
    await notices.dispatchTelegram(f.order.id);
    return { ...f, issue };
  }
  async function prompt(f: Awaited<ReturnType<typeof fixture>>) {
    await makeBot().handle(callback(f.telegramId, customerView('w', f.order.publicId)));
    return db.customerTelegramSession.findUniqueOrThrow({ where: { identityId: f.identity!.id } });
  }

  it('migrates an existing notification as SMS without changing status, key, attempts or error', async () => {
    expect(await db.orderNotification.findUniqueOrThrow({ where: { id: legacyId } })).toMatchObject({
      channel: 'SMS', dedupeKey: 'legacy-event', attempts: 2, status: 'FAILED', error: 'SMS_SEND_FAILED', messageId: null,
    });
  });
  it('preserves every existing SMS status and all original notification columns on populated migration', async () => {
    const rows = (await connection.query<Record<string, unknown>>('SELECT * FROM "OrderNotification" WHERE id = ANY($1) ORDER BY id',
      [legacyRows.map(row => row.id)])).rows;
    expect(rows).toHaveLength(6);
    for (const [index, row] of rows.entries()) {
      const { channel, messageId, ...original } = row;
      expect(channel).toBe('SMS');
      expect(messageId).toBeNull();
      expect(original).toEqual(legacyRows[index]);
    }
    // An old API's single-column conflict target is intentionally no longer compatible.
    await expect(connection.query(`INSERT INTO "OrderNotification" ("orderId",type,"dedupeKey","updatedAt")
      VALUES ($1,'ACTION_REQUIRED','legacy-target-check',NOW())
      ON CONFLICT ("dedupeKey") DO NOTHING`, [legacyRows[0]!.orderId])).rejects.toMatchObject({ code: '42P10' });
  });
  it('deduplicates within each channel and permits the same logical key in both channels', async () => {
    const f = await fixture();
    await db.orderNotification.create({ data: { orderId: f.order.id, type: 'ACTION_REQUIRED', dedupeKey: 'same-logical-key' } });
    const data = { orderId: f.order.id, type: 'ACTION_REQUIRED' as const, dedupeKey: 'same-logical-key' };
    // Domain writers enqueue on their transaction after locking the parent order.
    // Exercise that contract instead of racing an unlocked Prisma read/create upsert.
    const enqueue = () => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id} FOR UPDATE`;
      await telegramEvent(tx, data);
    });
    await Promise.all([enqueue(), enqueue()]);
    const saved = await db.orderNotification.findMany({ where: { dedupeKey: data.dedupeKey } });
    expect(saved).toHaveLength(2);
    expect(saved.map(e => e.channel).sort()).toEqual(['SMS', 'TELEGRAM']);
    await expect(db.orderNotification.create({ data: { ...data, channel: 'SMS' } })).rejects.toMatchObject({ code: 'P2002' });
  });
  it('each channel has independent claims/status and duplicate dispatch sends nothing twice', async () => {
    const f = await waiting();
    expect((await events(f.order.id, 'ACTION_REQUIRED')).map(e => e.status)).toEqual(['SENT', 'SENT']);
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    await Promise.all([notices.dispatch(f.order.id), notices.dispatchTelegram(f.order.id), notices.dispatchTelegram(f.order.id)]);
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });
  it('Telegram unknown outcome never changes SMS and is never automatically retried', async () => {
    telegram.send.mockRejectedValueOnce(new Error('synthetic provider body'));
    const f = await waiting();
    expect((await events(f.order.id)).find(e => e.channel === 'SMS')).toMatchObject({ status: 'SENT' });
    expect((await events(f.order.id)).find(e => e.channel === 'TELEGRAM')).toMatchObject({ status: 'SENDING', error: 'TELEGRAM_OUTCOME_UNKNOWN', attempts: 1 });
    await notices.dispatch(f.order.id);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.order.items[0]!.id } })).actualQty).toBe(1200);
    expect(JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls)).not.toContain('synthetic provider body');
  });
  it('SMS failure and manual retry do not alter/retry the successful Telegram delivery', async () => {
    sms.send.mockRejectedValueOnce(new Error('synthetic SMS provider failure'));
    const f = await waiting();
    const before = await events(f.order.id);
    const smsRow = before.find(e => e.channel === 'SMS')!;
    const telegramRow = before.find(e => e.channel === 'TELEGRAM')!;
    expect(smsRow.status).toBe('FAILED');
    expect(telegramRow.status).toBe('SENT');
    await db.orderNotification.update({ where: { id: smsRow.id }, data: { updatedAt: new Date(Date.now() - 61000) } });
    await coordination.retry({ orderId: f.order.id, ...seller }, f.issue.id);
    expect((await db.orderNotification.findUniqueOrThrow({ where: { id: smsRow.id } })).status).toBe('SENT');
    expect(await db.orderNotification.findUniqueOrThrow({ where: { id: telegramRow.id } })).toEqual(telegramRow);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(sms.send).toHaveBeenCalledTimes(2);
  });
  it.each(['unlinked', 'not-started', 'blocked', 'unconfigured'] as const)('does not deliver when %s', async mode => {
    const f = await fixture('ASSEMBLING', mode !== 'unlinked');
    if (mode === 'not-started') await db.telegramIdentity.update({ where: { id: f.identity!.id }, data: { customerBotStartedAt: null } });
    if (mode === 'blocked') await db.telegramIdentity.update({ where: { id: f.identity!.id }, data: { customerBotBlockedAt: new Date() } });
    if (mode === 'unconfigured') telegram.available = false;
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'MISSING' }, seller.userId, seller);
    await notices.dispatchTelegram(f.order.id);
    expect(telegram.send).not.toHaveBeenCalled();
    expect((await events(f.order.id)).find(e => e.channel === 'TELEGRAM')?.status).toBe('UNCONFIGURED');
    expect((await events(f.order.id)).find(e => e.channel === 'SMS')?.status).toBe('SENT');
  });
  it('a forbidden Telegram delivery records blocked state; /start reactivates the same identity', async () => {
    telegram.send.mockResolvedValueOnce('blocked');
    const f = await waiting();
    expect((await db.telegramIdentity.findUniqueOrThrow({ where: { id: f.identity!.id } })).customerBotBlockedAt).not.toBeNull();
    await makeBot().handle(text(f.telegramId, '/start'));
    expect(await db.telegramIdentity.findUniqueOrThrow({ where: { id: f.identity!.id } })).toMatchObject({ customerBotBlockedAt: null });
    expect((await db.user.findUniqueOrThrow({ where: { id: f.user.id } })).phone).toBeNull();
  });
  it('restart and simultaneous duplicate ForceReplies create exactly one business chat message', async () => {
    const f = await fixture();
    const session = await prompt(f);
    expect(session.step).toBe('TEXT');
    const update = text(f.telegramId, 'Оставьте у двери', session.promptMessageId!);
    await Promise.all([makeBot().handle(update), makeBot().handle(update)]);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id, authorType: 'CUSTOMER' } })).toBe(1);
    expect(await db.customerTelegramSession.count({ where: { identityId: f.identity!.id } })).toBe(0);
    const chat = await coordination.messages({ orderId: f.order.id, ...seller }, { limit: 30 });
    expect(chat.messages.some(m => m.text === 'Оставьте у двери')).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).staffUnread).toBe(1);
  });
  it('expired session and random or wrong-prompt messages cannot post', async () => {
    const f = await fixture();
    const session = await prompt(f);
    await makeBot().handle(text(f.telegramId, 'Случайное сообщение'));
    await makeBot().handle(text(f.telegramId, 'Чужой ответ', session.promptMessageId! + 1));
    await db.customerTelegramSession.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
    await makeBot().handle(text(f.telegramId, 'Поздний ответ', session.promptMessageId!));
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id } })).toBe(0);
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(0);
  });
  it('session identity and order ownership are rechecked inside the domain transaction', async () => {
    const a = await fixture(), b = await fixture();
    const session = await prompt(a);
    await expect(coordination.post(b.actor, 'forged', {
      sessionId: session.id, identityId: a.identity!.id, promptMessageId: session.promptMessageId!,
    })).rejects.toThrow();
    await expect(coordination.post({ publicId: a.order.publicId, userId: b.user.id }, 'forged', {
      sessionId: session.id, identityId: a.identity!.id, promptMessageId: session.promptMessageId!,
    })).rejects.toThrow();
    expect(await db.orderChatMessage.count({ where: { orderId: { in: [a.order.id, b.order.id] } } })).toBe(0);
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(1);
  });
  it('/cancel deletes pending input and an old reply cannot revive it', async () => {
    const f = await fixture(), session = await prompt(f);
    await makeBot().handle(text(f.telegramId, '/cancel'));
    await makeBot().handle(text(f.telegramId, 'Отменённый ответ', session.promptMessageId!));
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(0);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id } })).toBe(0);
  });
  it('cancel during delayed prompt delivery cannot recreate the canceled reservation', async () => {
    const f = await fixture();
    let release!: (value: Response) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { reply_markup?: { force_reply?: boolean } };
      if (body.reply_markup?.force_reply) {
        entered();
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Response.json({ ok: true, result: { message_id: ++messageSequence } });
    });
    const opening = makeBot().handle(callback(f.telegramId, customerView('w', f.order.publicId)));
    await waiting;
    await makeBot().handle(text(f.telegramId, '/cancel'));
    release(Response.json({ ok: true, result: { message_id: ++messageSequence } }));
    await opening;
    expect(await db.customerTelegramSession.count({ where: { identityId: f.identity!.id } })).toBe(0);
  });
  it('a pending notification for a superseded issue version is canceled rather than sent', async () => {
    const f = await waiting();
    await db.orderNotification.updateMany({
      where: { orderId: f.order.id, channel: 'TELEGRAM' }, data: { status: 'PENDING' },
    });
    await db.orderIssue.update({ where: { id: f.issue.id }, data: { version: { increment: 1 } } });
    telegram.send.mockClear();
    await notices.dispatchTelegram(f.order.id);
    expect(telegram.send).not.toHaveBeenCalled();
    expect((await events(f.order.id)).find(e => e.channel === 'TELEGRAM')?.status).toBe('CANCELED');
  });
  it('starting input for another order invalidates the old prompt', async () => {
    const f = await fixture(), first = await prompt(f);
    const secondOrder = await db.order.create({ data: {
      userId: f.user.id, customerName: 'Fixture', customerPhone: '+79990000002', type: 'PICKUP', subtotal: 1000, total: 1000, deliveryPrice: 0,
    } });
    await makeBot().handle(callback(f.telegramId, customerView('w', secondOrder.publicId)));
    await makeBot().handle(text(f.telegramId, 'Старый ответ', first.promptMessageId!));
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id } })).toBe(0);
    const current = await db.customerTelegramSession.findUniqueOrThrow({ where: { identityId: f.identity!.id } });
    expect(current.orderId).toBe(secondOrder.id);
  });
  it('chat rate limit rollback also rolls back session consumption', async () => {
    const f = await fixture(), session = await prompt(f);
    await db.orderChatMessage.createMany({ data: Array.from({ length: 15 }, () => ({
      orderId: f.order.id, authorType: 'CUSTOMER' as const, recipient: 'staff', text: 'fixture',
    })) });
    await expect(coordination.post(f.actor, 'Sixteenth', { sessionId: session.id, identityId: f.identity!.id, promptMessageId: session.promptMessageId! }))
      .rejects.toMatchObject({ status: 429 });
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(1);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id } })).toBe(15);
  });
  it('foreign order callbacks and messages do not leak data or mutate another account', async () => {
    const a = await waiting(), b = await fixture();
    await makeBot().handle(callback(b.telegramId, customerDecision(a.order.publicId, a.issue.id, a.issue.version, 'x')));
    await makeBot().handle(callback(b.telegramId, customerView('m', a.order.publicId)));
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { text?: string });
    expect(bodies.every(body => body.text === 'Заказ недоступен')).toBe(true);
    expect((await db.orderIssue.findUniqueOrThrow({ where: { id: a.issue.id } })).status).toBe('WAITING_CUSTOMER');
  });
  it.each([
    ['a', 'ACCEPT_ACTUAL', 'RESOLVED'], ['r', 'REQUEST_REDUCE', 'WAITING_SELLER'],
    ['x', 'REMOVE_ITEM', 'RESOLVED'], ['c', 'CANCEL_ORDER', 'CANCELED'],
  ] as const)('Telegram %s shares website coordination state', async (code, resolution, status) => {
    const f = await waiting();
    await makeBot().handle(callback(f.telegramId, customerDecision(f.order.publicId, f.issue.id, f.issue.version, code)));
    const view = await coordination.view(f.actor);
    expect(view.issues[0]).toMatchObject({ status, resolution });
    const item = (await orders.get(f.order.publicId, f.user.id)).items[0]!;
    if (code === 'x') expect(item).toMatchObject({ status: 'MISSING', actualTotal: 0 });
    if (code === 'a') {
      await staff.finishAssembly(f.order.id, seller);
      expect((await orders.get(f.order.publicId, f.user.id)).finalSubtotal).toBe(12000);
    }
    if (code === 'c') expect((await orders.get(f.order.publicId, f.user.id)).status).toBe('CANCELED');
    expect(item.price).toBe(10000);
  });
  it('commits item composition, unread and one durable customer notice per real change', async () => {
    const f = await fixture();
    const itemId = f.order.items[0]!.id;
    await staff.item(f.order.id, itemId, { status: 'PICKED', actualQty: 1050 }, seller.userId, seller);
    await vi.waitFor(async () => expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]?.status).toBe('SENT'));
    expect((await orders.get(f.order.publicId, f.user.id)).items[0]).toMatchObject({ status: 'PICKED', actualQty: 1050, actualTotal: 10500 });
    await staff.item(f.order.id, itemId, { status: 'PICKED', actualQty: 1050 }, seller.userId, seller);
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(1);
    await staff.item(f.order.id, itemId, { status: 'PENDING' }, seller.userId, seller);
    expect((await orders.get(f.order.publicId, f.user.id)).items[0]).toMatchObject({ status: 'PENDING', actualQty: null });
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(2);
    await staff.item(f.order.id, itemId, { status: 'MISSING' }, seller.userId, seller);
    expect((await orders.get(f.order.publicId, f.user.id)).items[0]).toMatchObject({ status: 'MISSING', actualQty: 0 });
    expect((await events(f.order.id, 'ACTION_REQUIRED')).filter(row => row.channel === 'TELEGRAM')).toHaveLength(1);
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(2);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id, recipient: 'customer' } })).toBe(3);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(3);
    for (const action of ['ITEM_PICKED', 'ITEM_RESET', 'ITEM_MISSING'])
      expect(await db.orderStaffAudit.count({ where: { orderId: f.order.id, action } })).toBe(1);
  });
  it('makes active extras visible immediately and notifies once after each committed add/edit/cancel', async () => {
    const f = await fixture();
    const original = notices.dispatchTelegram.bind(notices);
    const observed: number[] = [];
    vi.spyOn(notices, 'dispatchTelegram').mockImplementation(async id => {
      observed.push(await db.orderChatMessage.count({ where: { orderId: id } }));
      expect(await db.orderExtra.count({ where: { orderId: id, status: 'ACTIVE' } })).toBe(observed.length === 3 ? 0 : 1);
      return original(id);
    });
    const input = { title: 'Упаковка', quantity: 1, unitPrice: 30000 };
    const added = await staff.extra(f.order.id, seller.userId, input, undefined, undefined, seller);
    await vi.waitFor(() => expect(observed).toEqual([1]));
    expect((await orders.get(f.order.publicId, f.user.id))).toMatchObject({ subtotal: 10000, finalSubtotal: null, extras: [{ title: 'Упаковка', amount: 30000 }] });
    expect((await events(f.order.id, 'CHAT_MESSAGE'))).toHaveLength(1);
    const edited = await staff.extra(f.order.id, seller.userId, { ...input, quantity: 2 }, added.id, added.version, seller);
    await vi.waitFor(() => expect(observed).toEqual([1, 2]));
    expect((await orders.get(f.order.publicId, f.user.id)).extras).toMatchObject([{ quantity: 2, amount: 60000 }]);
    await staff.extra(f.order.id, seller.userId, { ...input, quantity: 2 }, edited.id, edited.version, seller);
    await expect(staff.extra(f.order.id, seller.userId, { ...input, quantity: 3 }, edited.id, added.version, seller)).rejects.toThrow();
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(2);
    await staff.extra(f.order.id, seller.userId, null, edited.id, edited.version, seller);
    await vi.waitFor(() => expect(observed).toEqual([1, 2, 3]));
    expect((await orders.get(f.order.publicId, f.user.id)).extras).toEqual([]);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(3);
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(3);
    for (const action of ['EXTRA_ADD', 'EXTRA_EDIT', 'EXTRA_CANCEL'])
      expect(await db.orderStaffAudit.count({ where: { orderId: f.order.id, action } })).toBe(1);
  });
  it('bulk discrete assembly creates one customer update for all picked positions', async () => {
    const f = await fixture();
    const products = ['Киви', 'Упаковка'];
    for (const [index, name] of products.entries()) await db.orderItem.create({ data: {
      orderId: f.order.id, productName: name, productSlug: 'bulk-' + index,
      unit: index ? 'PACK' : 'PIECE', qty: index + 1, price: 10000, priceQty: 1, total: (index + 1) * 10000,
    } });
    expect(await staff.confirmDiscrete(f.order.id, seller)).toBe(2);
    expect((await orders.get(f.order.publicId, f.user.id)).items.filter(item => item.status === 'PICKED')).toHaveLength(2);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id, recipient: 'customer' } })).toBe(1);
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(1);
    await vi.waitFor(async () => expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]?.status).toBe('SENT'));
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(1);
    expect(await db.orderStaffAudit.count({ where: { orderId: f.order.id, action: 'ITEM_PICKED' } })).toBe(2);
  });
  it('unknown Telegram result for an extra stays SENDING and never replays the committed mutation', async () => {
    const f = await fixture();
    telegram.send.mockResolvedValueOnce('unknown');
    await staff.extra(f.order.id, seller.userId, { title: 'Пакет', quantity: 1, unitPrice: 30000 }, undefined, undefined, seller);
    await vi.waitFor(async () => expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]).toMatchObject({
      status: 'SENDING', error: 'TELEGRAM_OUTCOME_UNKNOWN', attempts: 1,
    }));
    await notices.dispatchTelegram(f.order.id);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(await db.orderExtra.count({ where: { orderId: f.order.id, status: 'ACTIVE' } })).toBe(1);
    expect(await db.orderStaffAudit.count({ where: { orderId: f.order.id, action: 'EXTRA_ADD' } })).toBe(1);
  });
  it('seller replacement proposal and customer acceptance use the same issue version and price snapshot', async () => {
    const f = await fixture();
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'MISSING' }, seller.userId, seller);
    const issue = await db.orderIssue.findUniqueOrThrow({ where: { orderItemId: f.order.items[0]!.id } });
    const category = await db.category.create({ data: { name: 'Fixture', slug: randomUUID() } });
    const product = await db.product.create({ data: {
      categoryId: category.id, name: 'Огурцы', slug: randomUUID(), unit: 'GRAM', price: 20000, priceQty: 1000, min: 100, step: 100, portionQty: 100,
    } });
    const proposed = await coordination.propose({ orderId: f.order.id, ...seller }, issue.id, {
      version: issue.version, productId: product.id, qty: 500,
    });
    expect(proposed.version).toBe(issue.version + 1);
    expect((await events(f.order.id, 'ACTION_REQUIRED')).filter(e => e.channel === 'TELEGRAM')).toHaveLength(2);
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(0);
    expect((await orders.get(f.order.publicId, f.user.id)).issues).toMatchObject([{
      type: 'REPLACEMENT', status: 'WAITING_CUSTOMER', proposedName: 'Огурцы', proposedQty: 500,
    }]);
    await makeBot().handle(callback(f.telegramId, customerDecision(f.order.publicId, issue.id, proposed.version, 'p')));
    const detail = await orders.get(f.order.publicId, f.user.id);
    expect(detail.items).toHaveLength(2);
    expect(detail.items.find(item => item.productSlug === product.slug)).toMatchObject({ qty: 500, price: 20000, total: 10000 });
    expect(detail.issues).toMatchObject([{ resolution: 'ACCEPT_REPLACEMENT', status: 'RESOLVED', replacementItemId: expect.any(Number) }]);
  });
  it('stale version rejects and duplicate identical decisions do not create another chat event', async () => {
    const f = await waiting();
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PENDING' }, seller.userId, seller);
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PICKED', actualQty: 1300 }, seller.userId, seller);
    await makeBot().handle(callback(f.telegramId, customerDecision(f.order.publicId, f.issue.id, f.issue.version, 'a')));
    expect((await db.orderIssue.findUniqueOrThrow({ where: { id: f.issue.id } })).resolution).toBeNull();
    const issue = await db.orderIssue.findUniqueOrThrow({ where: { id: f.issue.id } });
    const data = callback(f.telegramId, customerDecision(f.order.publicId, issue.id, issue.version, 'a'));
    await Promise.all([makeBot().handle(data), makeBot().handle(data)]);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id, text: { startsWith: 'Покупатель согласился' } } })).toBe(1);
  });
  it('immediately dispatches a staff chat only after message, unread count and outbox commit', async () => {
    const f = await fixture();
    const original = notices.dispatchTelegram.bind(notices);
    const dispatch = vi.spyOn(notices, 'dispatchTelegram').mockImplementation(async id => {
      expect(await db.orderChatMessage.count({ where: { orderId: id } })).toBe(1);
      expect((await events(id, 'CHAT_MESSAGE')).filter(row => row.channel === 'TELEGRAM')).toHaveLength(1);
      expect((await db.order.findUniqueOrThrow({ where: { id } })).customerUnread).toBe(1);
      return original(id);
    });
    const saved = await coordination.post({ orderId: f.order.id, ...seller }, 'Immediate customer fixture');
    await vi.waitFor(() => expect(telegram.send).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith(f.order.id);
    await vi.waitFor(async () => expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]).toMatchObject({
      messageId: saved.id, channel: 'TELEGRAM', status: 'SENT', attempts: 1,
    }));
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(1);
  });
  it('immediate dispatch and sweep race claim once; UNKNOWN is never resent and seller post is non-blocking', async () => {
    const f = await fixture();
    let release!: (outcome: BotDelivery) => void;
    telegram.send.mockImplementationOnce(() => new Promise<BotDelivery>(resolve => { release = resolve; }));
    const saved = await coordination.post({ orderId: f.order.id, ...seller }, 'Unknown transport fixture');
    await vi.waitFor(() => expect(telegram.send).toHaveBeenCalledTimes(1));
    await Promise.all([notices.dispatchTelegram(f.order.id), notices.dispatchTelegram(f.order.id)]);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    release('unknown');
    await vi.waitFor(async () => expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]).toMatchObject({
      messageId: saved.id, status: 'SENDING', error: 'TELEGRAM_OUTCOME_UNKNOWN', attempts: 1,
    }));
    await notices.dispatchTelegram(f.order.id);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(1);
  });
  it('customer and staff-only chat do not echo through the CUSTOMER outbox', async () => {
    const f = await fixture();
    await coordination.post(f.actor, 'Customer to staff fixture');
    await db.$transaction(tx => appendMessage(tx, f.order.id, 'Staff only fixture', 'SELLER', seller.userId, null, 'staff'));
    expect(await events(f.order.id, 'CHAT_MESSAGE')).toHaveLength(0);
    expect(telegram.send).not.toHaveBeenCalled();
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ customerUnread: 0, staffUnread: 2 });
  });
  it('new staff chat creates one exact message notification and customer read state is shared', async () => {
    const f = await fixture();
    const message = await coordination.post({ orderId: f.order.id, ...seller }, 'Уточните удобное время');
    await notices.dispatchTelegram(f.order.id);
    const rows = await events(f.order.id, 'CHAT_MESSAGE');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: message.id, channel: 'TELEGRAM', status: 'SENT' });
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(1);
    await makeBot().handle(callback(f.telegramId, customerView('m', f.order.publicId)));
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).customerUnread).toBe(0);
  });
  it('notifications cannot delete chat history and deleted message/session references behave safely', async () => {
    const f = await fixture(), session = await prompt(f);
    const message = await coordination.post({ orderId: f.order.id, ...seller }, 'Fixture');
    await db.orderNotification.deleteMany({ where: { orderId: f.order.id } });
    expect(await db.orderChatMessage.count({ where: { id: message.id } })).toBe(1);
    await telegramEvent(db, { orderId: f.order.id, messageId: message.id, type: 'CHAT_MESSAGE', dedupeKey: 'deleted-message' });
    await db.orderChatMessage.delete({ where: { id: message.id } });
    await notices.dispatchTelegram(f.order.id);
    expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]).toMatchObject({ messageId: null, status: 'CANCELED' });
    await db.telegramIdentity.delete({ where: { id: f.identity!.id } });
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(0);
  });
  it('lifecycle notifications cover confirm, assembly, ready, payment and pickup completion with no-op dedupe', async () => {
    const f = await fixture('NEW');
    await staff.confirm(f.order.id, seller);
    await staff.confirm(f.order.id, seller);
    await notices.dispatchTelegram(f.order.id);
    await staff.startAssembly(f.order.id, seller);
    await notices.dispatchTelegram(f.order.id);
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PICKED', actualQty: 1000 }, seller.userId, seller);
    await staff.finishAssembly(f.order.id, seller);
    await notices.dispatchTelegram(f.order.id);
    await staff.confirmPayment(f.order.id, seller.userId, undefined, seller);
    await staff.confirmPayment(f.order.id, seller.userId, undefined, seller);
    await notices.dispatchTelegram(f.order.id);
    await staff.completePickup(f.order.id, seller);
    await notices.dispatchTelegram(f.order.id);
    const rows = (await events(f.order.id)).filter(e => e.channel === 'TELEGRAM');
    expect(rows.map(e => e.type)).toEqual(['ORDER_CONFIRMED', 'ASSEMBLY_STARTED', 'CHAT_MESSAGE', 'PAYMENT_READY', 'PAYMENT_RECEIVED', 'ORDER_COMPLETED']);
    expect(rows.every(e => e.status === 'SENT')).toBe(true);
  });
  it('OTHER delivery mutations publish customer status changes without any Telegram business writes', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.order.id }, data: { type: 'DELIVERY', deliveryPrice: null, total: null } });
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PICKED', actualQty: 1000 }, seller.userId, seller);
    await staff.finishAssembly(f.order.id, seller);
    await staff.confirmPayment(f.order.id, seller.userId, undefined, seller);
    await staff.delivery(f.order.id, { provider: 'OTHER', price: 50000, courierName: 'Courier fixture', courierPhone: '+79990000003' }, seller);
    await staff.handoff(f.order.id, seller);
    await staff.completeDelivery(f.order.id, seller);
    expect((await events(f.order.id)).filter(e => e.channel === 'TELEGRAM').map(e => e.type))
      .toEqual(['CHAT_MESSAGE', 'PAYMENT_READY', 'PAYMENT_RECEIVED', 'DELIVERY_CHANGED', 'DELIVERY_CHANGED', 'ORDER_COMPLETED']);
  });
  it('does not deliver an earlier assembly-start event after the order is reopened', async () => {
    vi.spyOn(notices, 'dispatch').mockResolvedValue(undefined);
    const f = await fixture('NEW');
    await staff.confirm(f.order.id, seller);
    await staff.startAssembly(f.order.id, seller);
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PICKED', actualQty: 1000 }, seller.userId, seller);
    await staff.finishAssembly(f.order.id, seller);
    await staff.reopen(f.order.id, seller);
    await notices.dispatchTelegram(f.order.id);
    expect((await events(f.order.id, 'ASSEMBLY_STARTED')).map(row => row.status)).toEqual(['CANCELED', 'SENT']);
    expect(telegram.send.mock.calls.filter(call => call[1].event.type === 'ASSEMBLY_STARTED')).toHaveLength(1);
  });
  it.each(['SELLER', 'USER'] as const)('cancellation preserves the %s initiator unread counter', async role => {
    const f = await waiting();
    const before = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    if (role === 'SELLER') await staff.cancel(f.order.id, seller.userId, seller.role, undefined, seller);
    else await coordination.decide(f.actor, f.issue.id, { version: f.issue.version, action: 'CANCEL_ORDER' });
    const after = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(after.customerUnread - before.customerUnread).toBe(role === 'SELLER' ? 1 : 0);
    expect(after.staffUnread - before.staffUnread).toBe(role === 'USER' ? 1 : 0);
    await notices.dispatchTelegram(f.order.id);
    expect((await events(f.order.id, 'ORDER_CANCELED'))[0]?.status).toBe('SENT');
  });
  it('slow Telegram delivery cannot hold open a committed staff mutation', async () => {
    const f = await fixture('NEW');
    let release!: (outcome: BotDelivery) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    telegram.send.mockImplementationOnce(async () => {
      entered();
      return new Promise<BotDelivery>(resolve => { release = resolve; });
    });
    await staff.confirm(f.order.id, seller);
    expect(telegram.send).not.toHaveBeenCalled();
    expect((await events(f.order.id, 'ORDER_CONFIRMED'))[0]?.status).toBe('PENDING');
    const sending = notices.dispatchTelegram(f.order.id);
    await started;
    try {
      await staff.startAssembly(f.order.id, seller);
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ASSEMBLING');
      expect((await events(f.order.id, 'ASSEMBLY_STARTED'))[0]?.status).toBe('PENDING');
    } finally { release('unknown'); await sending; }
    expect((await events(f.order.id, 'ORDER_CONFIRMED'))[0]?.status).toBe('SENDING');
  });
  it('a PostgreSQL write failure rolls back the reply claim and permits one later valid post', async () => {
    const f = await fixture(), session = await prompt(f);
    const reply = { sessionId: session.id, identityId: f.identity!.id, promptMessageId: session.promptMessageId! };
    await connection.query('ALTER TABLE "OrderChatMessage" ADD CONSTRAINT review_message_guard CHECK (text <> \'review rollback fixture\') NOT VALID');
    try {
      await expect(coordination.post(f.actor, 'review rollback fixture', reply)).rejects.toThrow();
      expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(1);
      expect(await db.orderChatMessage.count({ where: { orderId: f.order.id } })).toBe(0);
    } finally { await connection.query('ALTER TABLE "OrderChatMessage" DROP CONSTRAINT review_message_guard'); }
    await coordination.post(f.actor, 'Valid reply', reply);
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(0);
    expect(await db.orderChatMessage.count({ where: { orderId: f.order.id } })).toBe(1);
  });
  it('ownership changes after a prompt cannot transfer its session to the new owner', async () => {
    const a = await fixture(), b = await fixture(), session = await prompt(a);
    await db.order.update({ where: { id: a.order.id }, data: { userId: b.user.id } });
    await makeBot().handle(text(a.telegramId, 'Old owner reply', session.promptMessageId!));
    await expect(coordination.post({ publicId: a.order.publicId, userId: b.user.id }, 'New owner forged reply', {
      sessionId: session.id, identityId: a.identity!.id, promptMessageId: session.promptMessageId!,
    })).rejects.toThrow();
    expect(await db.orderChatMessage.count({ where: { orderId: a.order.id } })).toBe(0);
  });
  it.each(['read', 'deleted-identity', 'foreign-message'] as const)('pending chat delivery is safe after %s', async mode => {
    const f = await fixture();
    // Hold only the immediate dispatcher so this test can exercise the sweep's stale-row rules.
    const immediate = vi.spyOn(notices, 'dispatchTelegram').mockResolvedValue(undefined);
    const saved = await coordination.post({ orderId: f.order.id, ...seller }, 'Exact message fixture');
    if (mode === 'read') await coordination.read(f.actor, saved.id);
    if (mode === 'deleted-identity') await db.telegramIdentity.delete({ where: { id: f.identity!.id } });
    if (mode === 'foreign-message') {
      const other = await fixture();
      const unrelated = await coordination.post({ orderId: other.order.id, ...seller }, 'Foreign private message');
      await db.orderNotification.updateMany({ where: { orderId: f.order.id }, data: { messageId: unrelated.id } });
    }
    immediate.mockRestore();
    await notices.dispatchTelegram(f.order.id);
    expect(telegram.send).not.toHaveBeenCalled();
    expect((await events(f.order.id, 'CHAT_MESSAGE'))[0]?.status).toBe(mode === 'deleted-identity' ? 'UNCONFIGURED' : 'CANCELED');
  });
  it('deleting an order cascades its pending reply without deleting the linked identity', async () => {
    const f = await fixture(), session = await prompt(f);
    await db.order.delete({ where: { id: f.order.id } });
    expect(await db.customerTelegramSession.count({ where: { id: session.id } })).toBe(0);
    expect(await db.telegramIdentity.count({ where: { id: f.identity!.id } })).toBe(1);
  });
  it('coalesces pending delivery updates and never announces payment readiness after payment', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.order.id }, data: { type: 'DELIVERY', total: null, deliveryPrice: null } });
    await staff.item(f.order.id, f.order.items[0]!.id, { status: 'PICKED', actualQty: 1000 }, seller.userId, seller);
    await staff.finishAssembly(f.order.id, seller);
    await staff.confirmPayment(f.order.id, seller.userId, undefined, seller);
    await notices.dispatchTelegram(f.order.id);
    expect((await events(f.order.id, 'PAYMENT_READY')).find(row => row.channel === 'TELEGRAM')?.status).toBe('CANCELED');
    telegram.send.mockClear();
    await staff.delivery(f.order.id, { provider: 'OTHER', price: 10000, courierName: 'Fixture', courierPhone: '+79990000003' }, seller);
    await staff.handoff(f.order.id, seller);
    await notices.dispatchTelegram(f.order.id);
    expect((await events(f.order.id, 'DELIVERY_CHANGED')).map(row => row.status)).toEqual(['CANCELED', 'SENT']);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledWith(String(f.telegramId), expect.objectContaining({
      event: expect.objectContaining({ type: 'DELIVERY_CHANGED' }),
      order: expect.objectContaining({ delivery: expect.objectContaining({ status: 'PICKED_UP' }) }),
    }));
  });
  it('cancellation emits a customer event and a failed transition leaves no event', async () => {
    const f = await fixture('NEW');
    await expect(staff.finishAssembly(f.order.id, seller)).rejects.toThrow();
    expect(await events(f.order.id)).toHaveLength(0);
    await staff.cancel(f.order.id, seller.userId, seller.role, 'Fixture', seller);
    await staff.cancel(f.order.id, seller.userId, seller.role, 'Fixture', seller);
    expect((await events(f.order.id)).map(e => e.type)).toEqual(['ORDER_CANCELED']);
  });
  it.each(['sent', 'blocked', 'rejected', 'server', 'timeout', 'malformed'] as const)(
    'real CUSTOMER provider through gateway preserves durable outbox outcome %s', async mode => {
      const gateway = 'http://127.0.0.1:19001';
      vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
      vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
      vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
      vi.stubEnv('TELEGRAM_CUSTOMER_WEBHOOK_SECRET', randomUUID());
      vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', randomUUID());
      const provider = new CustomerNotificationService();
      expect(provider.available).toBe(true);
      const dispatcher = new NotificationService(db as unknown as DbService, sms, provider);
      const f = await fixture();
      // Hold only the new immediate trigger to exercise the unchanged PENDING sweep/claim path.
      const immediate = vi.spyOn(notices, 'dispatchTelegram').mockResolvedValue(undefined);
      await staff.item(f.order.id, f.order.items[0]!.id, { status: 'MISSING' }, seller.userId, seller);
      immediate.mockRestore();
      if (mode === 'timeout') fetcher.mockRejectedValueOnce(new DOMException('private provider fixture', 'TimeoutError'));
      else if (mode === 'malformed') fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));
      else if (mode !== 'sent') fetcher.mockResolvedValueOnce(new Response('{}', {
        status: mode === 'blocked' ? 403 : mode === 'rejected' ? 400 : 502,
      }));
      await Promise.all([dispatcher.dispatchTelegram(f.order.id), dispatcher.dispatchTelegram(f.order.id)]);
      await dispatcher.dispatchTelegram(f.order.id);
      const rows = await events(f.order.id, 'ACTION_REQUIRED');
      const status = mode === 'sent' ? 'SENT' : mode === 'blocked' || mode === 'rejected' ? 'FAILED' : 'SENDING';
      expect(rows.find(row => row.channel === 'TELEGRAM')).toMatchObject({ status, attempts: 1 });
      expect(rows.find(row => row.channel === 'SMS')?.status).toBe('SENT');
      expect((await db.telegramIdentity.findUniqueOrThrow({ where: { id: f.identity!.id } })).customerBotBlockedAt !== null).toBe(mode === 'blocked');
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.order.items[0]!.id } })).status).toBe('MISSING');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]![0]).toBe(gateway + '/v1/customer/sendMessage');
      expect(JSON.stringify(fetcher.mock.calls).includes(process.env.TELEGRAM_CUSTOMER_BOT_TOKEN!)).toBe(false);
      expect(JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls)).not.toContain('private provider fixture');
    },
  );
  it.each(['timeout', 'malformed', 'missing-id'] as const)(
    'gateway UNKNOWN %s preserves unbound CHAT and explicit /resume binds a single reply after restart', async mode => {
      const gateway = 'http://127.0.0.1:19001';
      vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', gateway);
      vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
      vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
      const f = await fixture();
      if (mode === 'timeout') fetcher.mockRejectedValueOnce(new DOMException('fixture', 'TimeoutError'));
      else fetcher.mockResolvedValueOnce(mode === 'malformed' ? new Response('invalid') : Response.json({ ok: true }));
      await makeBot().handle(callback(f.telegramId, customerView('w', f.order.publicId)));
      const pending = await db.customerTelegramSession.findUniqueOrThrow({ where: { identityId: f.identity!.id } });
      expect(pending).toMatchObject({ action: 'CHAT', step: 'PROMPT', promptMessageId: null });
      await makeBot().handle(text(f.telegramId, 'Unbound input', 999));
      expect(await db.orderChatMessage.count({ where: { orderId: f.order.id, authorType: 'CUSTOMER' } })).toBe(0);
      await makeBot().handle(text(f.telegramId, '/resume'));
      const resumed = await db.customerTelegramSession.findUniqueOrThrow({ where: { identityId: f.identity!.id } });
      expect(resumed.id).not.toBe(pending.id);
      expect(resumed.promptMessageId).not.toBeNull();
      const update = text(f.telegramId, 'Bound fixture', resumed.promptMessageId!);
      await Promise.all([makeBot().handle(update), makeBot().handle(update)]);
      expect(await db.orderChatMessage.count({ where: { orderId: f.order.id, authorType: 'CUSTOMER' } })).toBe(1);
      expect(await db.customerTelegramSession.count({ where: { identityId: f.identity!.id } })).toBe(0);
      expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(gateway + '/v1/customer/'))).toBe(true);
    },
  );

});
