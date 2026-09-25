import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Unit } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { StaffService } from '../src/staff/staff.service.js';
import { NotificationService } from '../src/order/notification.service.js';
import { StaffBotFlowService } from '../src/telegram/staff-bot-flow.service.js';
import { StaffBotService } from '../src/telegram/staff-bot.service.js';
import { StaffLinkService } from '../src/telegram/staff-link.service.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { staffConfirmData, staffData } from '../src/telegram/staff-bot.js';

// Real transactions/concurrency, all existing migrations, isolated loopback schema.
describe.skipIf(!process.env.DATABASE_URL)('STAFF durable input PostgreSQL', () => {
  const schema = 'staff_flow_test_' + randomUUID().replaceAll('-', '');
  let connection: pg.Client, db: PrismaClient, staff: StaffService;
  let created = false, sequence = 100;
  const fetcher = vi.fn<typeof fetch>();
  const notices = { dispatch: vi.fn(async () => {}), dispatchTelegram: vi.fn(async () => {}) };
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error('Local test database required');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^staff_flow_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    await connection.query('SET search_path TO "' + schema + '"');
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    db = new PrismaClient({ adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL, options: '-c search_path=' + schema,
    }, { schema }) });
    staff = new StaffService(db as unknown as DbService, notices as unknown as NotificationService);
  }, 60000);
  beforeEach(async () => {
    vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
    vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', randomUUID());
    vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
    fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: ++sequence } }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await db.shopSettings.upsert({ where: { id: 1 }, create: { id: 1 },
      update: { maxOrderExtraUnitPrice: 500000, maxOrderExtrasTotal: 1000000 } });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await db?.$disconnect();
    if (created && /^staff_flow_test_[a-f0-9]{32}$/.test(schema))
      await connection.query('DROP SCHEMA "' + schema + '" CASCADE');
    await connection?.end();
  }, 30000);

  function services() {
    const typed = db as unknown as DbService;
    const telegram = new TelegramService(typed);
    const flow = new StaffBotFlowService(typed, staff, telegram);
    const bot = new StaffBotService(typed, staff, telegram, new StaffLinkService(typed), flow);
    return { flow, bot };
  }
  async function fixture(role: 'SELLER' | 'ADMIN' = 'SELLER', unit: Unit = 'GRAM') {
    const user = await db.user.create({ data: { role, name: 'Staff fixture' } });
    const telegramId = 300000 + user.id;
    const identity = await db.staffTelegramIdentity.create({ data: { userId: user.id, telegramUserId: BigInt(telegramId) } });
    vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', String(telegramId));
    const order = await db.order.create({ data: {
      type: 'PICKUP', status: 'ASSEMBLING', customerName: 'Fixture', customerPhone: '+79990000001',
      subtotal: 42000, total: 42000, deliveryPrice: 0,
      items: { create: { productName: 'Товар', productSlug: 'fixture', unit, price: 60000,
        priceQty: unit === 'GRAM' ? 1000 : 1, qty: unit === 'GRAM' ? 700 : 1, total: 42000 } },
    }, include: { items: true } });
    return { identity, order, telegramId, actor: { userId: user.id, role }, ...services() };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const session = (f: Fixture) => db.staffTelegramSession.findUniqueOrThrow({ where: { identityId: f.identity.id } });
  const pending = (f: Fixture) => db.staffTelegramSession.findUnique({ where: { identityId: f.identity.id } });
  const callback = (f: Fixture, data: string) => ({
    callback_query: { id: 'fixture-callback', data, from: { id: f.telegramId, is_bot: false },
      message: { message_id: 44, chat: { id: f.telegramId, type: 'private' } } },
  });
  const message = (f: Fixture, text: string, prompt?: number) => ({
    message: { message_id: ++sequence, from: { id: f.telegramId, is_bot: false },
      chat: { id: f.telegramId, type: 'private' }, text,
      ...(prompt ? { reply_to_message: { message_id: prompt } } : {}) },
  });
  async function reply(f: Fixture, text: string) {
    await f.bot.handle(message(f, text, (await session(f)).promptMessageId!));
  }
  async function extra(f: Fixture) {
    await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
    for (const text of ['сервис', '2', '123,45', '-']) await reply(f, text);
    return staffConfirmData(f.order.id, 'xs', (await session(f)).confirmationCode!);
  }
  const audits = (f: Fixture, action: string) => db.orderStaffAudit.findMany({ where: { orderId: f.order.id, action } });

  it.each(['timeout', 'reset', 'malformed', 'missing-message', 'bad-id'])(
    'persists initial EXTRA when Telegram has unknown %s result', async kind => {
      const f = await fixture();
      if (kind === 'timeout') fetcher.mockRejectedValueOnce(new DOMException('Synthetic timeout', 'TimeoutError'));
      if (kind === 'reset') fetcher.mockRejectedValueOnce(new Error('Synthetic connection reset'));
      if (kind === 'malformed') fetcher.mockResolvedValueOnce(new Response('invalid json'));
      if (kind === 'missing-message') fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
      if (kind === 'bad-id') fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: '123' } }));
      await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
      expect(await session(f)).toMatchObject({ step: 'title', promptMessageId: null });
      expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(0);
      expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
      // Fresh service instance has no in-memory recovery state.
      await services().bot.handle(message(f, '/resume'));
      expect((await session(f)).promptMessageId).toBeGreaterThan(0);
      await reply(f, 'сервис');
      expect(await session(f)).toMatchObject({ step: 'quantity', payload: { title: 'сервис' } });
    });

  it.each([0, 1, 2])('recovers EXTRA after unknown next prompt at step %i', async index => {
    const f = await fixture();
    await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
    const values = ['сервис', '2', '123,45', '-'];
    for (let i = 0; i < index; i++) await reply(f, values[i]!);
    const oldPrompt = (await session(f)).promptMessageId!;
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await reply(f, values[index]!);
    const waiting = await session(f);
    expect(waiting.step).toBe(['quantity', 'price', 'comment'][index]);
    expect(waiting.promptMessageId).toBeNull();
    await f.bot.handle(message(f, 'stale', oldPrompt));
    await f.bot.handle(message(f, 'unacknowledged prompt', 9999));
    expect(await session(f)).toEqual(waiting);
    await services().bot.handle(message(f, '/resume'));
    for (let i = index + 1; i < values.length; i++) await reply(f, values[i]!);
    const data = staffConfirmData(f.order.id, 'xs', (await session(f)).confirmationCode!);
    await Promise.all([f.bot.handle(callback(f, data)), services().bot.handle(callback(f, data))]);
    const rows = await db.orderExtra.findMany({ where: { orderId: f.order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'сервис', quantity: 2, unitPrice: 12345, amount: 24690, status: 'ACTIVE' });
    expect(await audits(f, 'EXTRA_ADD')).toMatchObject([{ userId: f.actor.userId, role: 'SELLER' }]);
    expect(await pending(f)).toBeNull();
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as { text?: string });
    expect(bodies.some(body => body.text?.includes('Доп. позиции: 1'))).toBe(true);
  });

  it('serializes duplicate ForceReply updates in PostgreSQL', async () => {
    const f = await fixture();
    await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
    const update = message(f, 'сервис', (await session(f)).promptMessageId!);
    await Promise.all([f.bot.handle(update), services().bot.handle(update), f.bot.handle(update)]);
    expect(await session(f)).toMatchObject({ step: 'quantity', payload: { title: 'сервис' } });
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
  });

  it.each(['price', 'total'])('retains confirmation after real ShopSettings %s limit rejection', async kind => {
    const f = await fixture();
    const code = await extra(f);
    await db.shopSettings.update({ where: { id: 1 }, data: kind === 'price'
      ? { maxOrderExtraUnitPrice: 10000 } : { maxOrderExtrasTotal: 10000 } });
    await f.bot.handle(callback(f, code));
    expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(0);
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
    expect(await session(f)).toMatchObject({ step: 'CONFIRM', payload: { title: 'сервис', unitPrice: 12345 } });
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as { text?: string });
    expect(bodies.some(body => body.text?.startsWith(kind === 'price' ? 'Максимальная цена услуги' : 'Максимальная сумма услуг'))).toBe(true);
    await db.shopSettings.update({ where: { id: 1 }, data: { maxOrderExtraUnitPrice: 500000, maxOrderExtrasTotal: 1000000 } });
    await f.bot.handle(callback(f, code)); // Old callback may not retry even after policy changes.
    expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(0);
    await f.bot.handle(message(f, '/resume'));
    await f.bot.handle(callback(f, staffConfirmData(f.order.id, 'xs', (await session(f)).confirmationCode!)));
    expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(1);
  });

  it('retains an EXTRA after assembly ends without creating rows/audit', async () => {
    const f = await fixture(), code = await extra(f);
    await db.order.update({ where: { id: f.order.id }, data: { status: 'READY' } });
    await f.bot.handle(callback(f, code));
    expect((await session(f)).step).toBe('CONFIRM');
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
    expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(0);
    await f.bot.handle(message(f, '/cancel'));
    expect(await pending(f)).toBeNull();
  });

  it('does not repeat a committed EXTRA after a lost DB return value', async () => {
    const f = await fixture(), code = await extra(f);
    const original = staff.extra.bind(staff);
    vi.spyOn(staff, 'extra').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('Synthetic lost DB commit result');
    });
    await expect(f.bot.handle(callback(f, code))).rejects.toThrow('Staff Telegram update failed');
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as { text?: string });
    expect(bodies.some(body => body.text ===
      'Результат действия не подтверждён. Проверьте заказ через /orders. Не повторяйте действие до проверки.')).toBe(true);
    expect(JSON.stringify(vi.mocked(Logger.prototype.error).mock.calls)).not.toContain('Synthetic lost DB commit result');
    expect((await session(f)).step).toBe('COMMITTING');
    await db.staffTelegramSession.update({ where: { identityId: f.identity.id }, data: { expiresAt: new Date(0) } });
    await services().bot.handle(message(f, 'ordinary input'));
    await services().bot.handle(message(f, 'stale reply', 8100));
    await services().bot.handle(message(f, '/resume'));
    await services().bot.handle(message(f, '/cancel'));
    await services().bot.handle(callback(f, code));
    expect((await session(f)).step).toBe('COMMITTING');
    expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(1);
  });

  it('does not repeat EXTRA when editing the saved dashboard times out', async () => {
    const f = await fixture(), code = await extra(f);
    fetcher.mockRejectedValueOnce(new DOMException('Synthetic dashboard timeout', 'TimeoutError'));
    await f.bot.handle(callback(f, code));
    await f.bot.handle(callback(f, code));
    await f.bot.handle(message(f, '/orders'));
    expect(await pending(f)).toBeNull();
    expect(await db.orderExtra.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(1);
  });

  it.each(['GRAM', 'PIECE'] as const)('recovers %s ITEM and records one mutation at snapshot price', async unit => {
    const f = await fixture('SELLER', unit), item = f.order.items[0]!;
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await f.bot.handle(callback(f, staffData(f.order.id, unit === 'GRAM' ? 'w' : 'q', item.id)));
    await services().bot.handle(message(f, '/resume'));
    const update = message(f, unit === 'GRAM' ? '742' : '2', (await session(f)).promptMessageId!);
    await Promise.all([f.bot.handle(update), services().bot.handle(update)]);
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      price: 60000, priceQty: item.priceQty, actualQty: unit === 'GRAM' ? 742 : 2,
      actualTotal: unit === 'GRAM' ? 44520 : 120000, status: 'PICKED',
    });
    expect(await audits(f, 'ITEM_PICKED')).toMatchObject([{ userId: f.actor.userId, role: 'SELLER' }]);
    expect(await pending(f)).toBeNull();
  });

  it.each(['PIECE', 'PACK', 'BUNCH'] as const)(
    'one-tap %s picks requested quantity once at snapshot price with linked audit', async unit => {
      const f = await fixture('SELLER', unit), item = f.order.items[0]!;
      await db.orderItem.update({ where: { id: item.id }, data: { qty: 3, total: 180000 } });
      const action = callback(f, staffData(f.order.id, 'a', item.id));
      await Promise.all([f.bot.handle(action), services().bot.handle(action)]);
      await f.bot.handle(action);
      expect(await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
        status: 'PICKED', actualQty: 3, actualTotal: 180000, price: 60000,
      });
      expect(await audits(f, 'ITEM_PICKED')).toMatchObject([{ userId: f.actor.userId, role: 'SELLER', entityId: item.id }]);
      expect(await audits(f, 'ITEM_PICKED')).toHaveLength(1);
      expect(await pending(f)).toBeNull();
    });

  it('bulk picks only pending discrete positions and preserves GRAM, processed and issue-linked items', async () => {
    const f = await fixture(), weighted = f.order.items[0]!;
    const add = (name: string, unit: 'PIECE' | 'PACK' | 'BUNCH', qty: number) =>
      db.orderItem.create({ data: { orderId: f.order.id, productName: name, productSlug: name,
        unit, qty, price: 10000, priceQty: 1, total: qty * 10000 } });
    const piece = await add('piece', 'PIECE', 3);
    const pack = await add('pack', 'PACK', 1);
    const bunch = await add('bunch', 'BUNCH', 2);
    const picked = await add('picked', 'PIECE', 1);
    await staff.item(f.order.id, picked.id, { status: 'PICKED', actualQty: 1 }, f.actor.userId, f.actor);
    const missing = await add('missing', 'PACK', 1);
    await staff.item(f.order.id, missing.id, { status: 'MISSING' }, f.actor.userId, f.actor);
    const issue = await add('issue', 'BUNCH', 1);
    await staff.item(f.order.id, issue.id, { status: 'MISSING' }, f.actor.userId, f.actor);
    await staff.item(f.order.id, issue.id, { status: 'PENDING' }, f.actor.userId, f.actor);
    const before = (await audits(f, 'ITEM_PICKED')).length;
    const action = callback(f, staffData(f.order.id, 'k'));
    await Promise.all([f.bot.handle(action), services().bot.handle(action)]);
    await f.bot.handle(action);
    for (const [id, qty] of [[piece.id, 3], [pack.id, 1], [bunch.id, 2]])
      expect(await db.orderItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PICKED', actualQty: qty });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: weighted.id } })).toMatchObject({ status: 'PENDING' });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: picked.id } })).toMatchObject({ status: 'PICKED', actualQty: 1 });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: missing.id } })).toMatchObject({ status: 'MISSING' });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({ status: 'PENDING' });
    const rows = await audits(f, 'ITEM_PICKED');
    expect(rows).toHaveLength(before + 3);
    expect(rows.slice(before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: f.actor.userId, role: 'SELLER', entityId: piece.id }),
      expect.objectContaining({ userId: f.actor.userId, role: 'SELLER', entityId: pack.id }),
      expect.objectContaining({ userId: f.actor.userId, role: 'SELLER', entityId: bunch.id }),
    ]));
  });

  it('bulk is all-or-nothing when one pending discrete quantity is invalid', async () => {
    const f = await fixture('ADMIN', 'PIECE'), first = f.order.items[0]!;
    const invalid = await db.orderItem.create({ data: { orderId: f.order.id, productName: 'invalid',
      productSlug: 'invalid', unit: 'PACK', qty: 0, price: 10000, priceQty: 1, total: 0 } });
    await f.bot.handle(callback(f, staffData(f.order.id, 'k')));
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'PENDING' });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: invalid.id } })).toMatchObject({ status: 'PENDING' });
    expect(await audits(f, 'ITEM_PICKED')).toHaveLength(0);
  });

  it('one-tap cannot pick GRAM and normal finish rules still apply after discrete confirmation', async () => {
    const f = await fixture('SELLER', 'PIECE'), item = f.order.items[0]!;
    await f.bot.handle(callback(f, staffData(f.order.id, 'a', item.id)));
    await staff.finishAssembly(f.order.id, f.actor);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('READY');
    const weighted = await fixture('SELLER', 'GRAM'), gram = weighted.order.items[0]!;
    await weighted.bot.handle(callback(weighted, staffData(weighted.order.id, 'a', gram.id)));
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: gram.id } })).toMatchObject({ status: 'PENDING' });
    expect(await audits(weighted, 'ITEM_PICKED')).toHaveLength(0);
  });

  it('recovers CANCEL confirmation and records the linked ADMIN once', async () => {
    const f = await fixture('ADMIN');
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await f.bot.handle(callback(f, staffData(f.order.id, 'z')));
    await services().bot.handle(message(f, '/resume'));
    await reply(f, 'Нет товара');
    await services().bot.handle(message(f, '/resume'));
    const data = staffConfirmData(f.order.id, 'zy', (await session(f)).confirmationCode!);
    await Promise.all([f.bot.handle(callback(f, data)), services().bot.handle(callback(f, data))]);
    expect(await audits(f, 'CANCEL')).toMatchObject([{ userId: f.actor.userId, role: 'ADMIN' }]);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('CANCELED');
    expect(await pending(f)).toBeNull();
  });

  it('recovers OTHER delivery across unknown courier-phone prompt and audits once', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.order.id }, data: {
      type: 'DELIVERY', status: 'READY', finalSubtotal: 42000, finalTotal: 42000,
      assemblyFinalizedAt: new Date(), payment: { create: { status: 'PAID', amount: 42000 } },
    } });
    await f.bot.handle(callback(f, staffData(f.order.id, 'd')));
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await reply(f, 'Курьер');
    expect(await session(f)).toMatchObject({ step: 'courierPhone', promptMessageId: null, payload: { courierName: 'Курьер' } });
    await services().bot.handle(message(f, '/resume'));
    for (const value of ['+79990000002', '350,25', '-', '-']) await reply(f, value);
    const data = staffConfirmData(f.order.id, 'ds', (await session(f)).confirmationCode!);
    await Promise.all([f.bot.handle(callback(f, data)), services().bot.handle(callback(f, data))]);
    expect(await db.delivery.findUniqueOrThrow({ where: { orderId: f.order.id } })).toMatchObject({
      provider: 'OTHER', status: 'ASSIGNED', price: 35025,
    });
    expect(await audits(f, 'DELIVERY_UPDATE')).toHaveLength(1);
    expect(await pending(f)).toBeNull();
  });

  it('revokes resume/input access immediately when linked staff role becomes USER', async () => {
    const f = await fixture();
    await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
    const before = await session(f);
    await db.user.update({ where: { id: f.actor.userId }, data: { role: 'USER' } });
    await f.bot.handle(message(f, '/resume'));
    await f.bot.handle(message(f, 'сервис', before.promptMessageId!));
    expect(await session(f)).toEqual(before);
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
  });
  it('retains an edited EXTRA when its domain version changed before confirmation', async () => {
    const f = await fixture();
    const current = await staff.extra(f.order.id, f.actor.userId,
      { title: 'Initial', quantity: 1, unitPrice: 100 }, undefined, undefined, f.actor);
    await f.bot.handle(callback(f, staffData(f.order.id, 'xe', current.id)));
    for (const value of ['Edited', '2', '2,00', '-']) await reply(f, value);
    const code = staffConfirmData(f.order.id, 'xs', (await session(f)).confirmationCode!);
    await staff.extra(f.order.id, f.actor.userId, { title: 'Site edit', quantity: 1, unitPrice: 150 },
      current.id, current.version, f.actor);
    await f.bot.handle(callback(f, code));
    expect(await session(f)).toMatchObject({ step: 'CONFIRM', payload: { title: 'Edited', extraId: current.id, version: current.version } });
    expect(await audits(f, 'EXTRA_EDIT')).toHaveLength(1);
    expect(await db.orderExtra.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ title: 'Site edit' });
  });

  it('retains DELIVERY confirmation when the authoritative payment state rejects it', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.order.id }, data: {
      type: 'DELIVERY', status: 'READY', finalSubtotal: 42000, finalTotal: 42000,
      assemblyFinalizedAt: new Date(), payment: { create: { status: 'PAID', amount: 42000 } },
    } });
    await f.bot.handle(callback(f, staffData(f.order.id, 'd')));
    for (const value of ['Курьер', '+79990000002', '350,25', '-', '-']) await reply(f, value);
    const code = staffConfirmData(f.order.id, 'ds', (await session(f)).confirmationCode!);
    await db.orderPayment.update({ where: { orderId: f.order.id }, data: { status: 'AWAITING' } });
    await f.bot.handle(callback(f, code));
    expect(await session(f)).toMatchObject({ step: 'CONFIRM', payload: { courierName: 'Курьер', price: 35025 } });
    expect(await audits(f, 'DELIVERY_UPDATE')).toHaveLength(0);
    expect(await db.delivery.count({ where: { orderId: f.order.id } })).toBe(0);
  });

  it('keeps a successfully saved next step if the DB response is lost before prompt send', async () => {
    const f = await fixture();
    await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
    const original = db.staffTelegramSession.updateMany.bind(db.staffTelegramSession);
    vi.spyOn(db.staffTelegramSession, 'updateMany').mockImplementationOnce(async args => {
      await original(args);
      throw new Error('Synthetic lost state-save response');
    });
    await reply(f, 'сервис');
    expect(await session(f)).toMatchObject({ step: 'quantity', promptMessageId: null, payload: { title: 'сервис' } });
    await services().bot.handle(message(f, '/resume'));
    await reply(f, '2');
    expect(await session(f)).toMatchObject({ step: 'price', payload: { quantity: 2 } });
  });

  function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  async function fixedSessionTime(run: () => Promise<void>) {
    // Only in this disposable schema. Force an ABA case where timestamps cannot
    // distinguish a deleted/recreated session or two versions of the same step.
    await connection.query(`CREATE FUNCTION staff_flow_fixed_time() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW."updatedAt" := TIMESTAMP '2026-01-01 00:00:00'; RETURN NEW; END $$`);
    try {
      await connection.query(`CREATE TRIGGER staff_flow_fixed_time BEFORE INSERT OR UPDATE
        ON "StaffTelegramSession" FOR EACH ROW EXECUTE FUNCTION staff_flow_fixed_time()`);
      await run();
    } finally {
      await connection.query('DROP TRIGGER IF EXISTS staff_flow_fixed_time ON "StaffTelegramSession"');
      await connection.query('DROP FUNCTION staff_flow_fixed_time()');
    }
  }

  it('fences an ABA session replacement even with identical updatedAt and pending step', async () => {
    await fixedSessionTime(async () => {
      const f = await fixture();
      const firstSent = gate<void>(), secondSent = gate<void>();
      const firstResponse = gate<Response>(), secondResponse = gate<Response>();
      fetcher.mockImplementationOnce(() => { firstSent.resolve(); return firstResponse.promise; });
      fetcher.mockImplementationOnce(() => { secondSent.resolve(); return secondResponse.promise; });
      const first = f.flow.start(f.identity.id, f.telegramId, 44, f.order.id, null, 'EXTRA', 'title');
      let second: Promise<boolean> | undefined;
      try {
        await firstSent.promise;
        const original = await session(f);
        expect(await f.flow.cancel(f.identity.id)).toBe(true);
        second = services().flow.start(f.identity.id, f.telegramId, 44, f.order.id, null, 'EXTRA', 'title');
        await secondSent.promise;
        const replacement = await session(f);
        expect(replacement.updatedAt).toEqual(original.updatedAt);
        expect(replacement.confirmationCode).not.toBe(original.confirmationCode);
        expect(replacement).toMatchObject({ step: original.step, promptMessageId: null });

        firstResponse.resolve(Response.json({ ok: true, result: { message_id: 8100 } }));
        expect(await first).toBe(false);
        expect(await session(f)).toEqual(replacement);
        await f.bot.handle(message(f, 'stale', 8100));
        expect(await session(f)).toEqual(replacement);

        secondResponse.resolve(Response.json({ ok: true, result: { message_id: 8200 } }));
        expect(await second).toBe(true);
        expect((await session(f)).promptMessageId).toBe(8200);
        await reply(f, 'сервис');
        expect(await session(f)).toMatchObject({ step: 'quantity', payload: { title: 'сервис' } });
        expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
      } finally {
        firstResponse.resolve(Response.json({ ok: false }));
        secondResponse.resolve(Response.json({ ok: false }));
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    });
  });

  it('allows only one of two resumes sharing the same DB snapshot to bind a prompt', async () => {
    await fixedSessionTime(async () => {
      const f = await fixture();
      await f.flow.start(f.identity.id, f.telegramId, 44, f.order.id, null, 'EXTRA', 'title');
      const original = await session(f), ready = gate<void>();
      const find = db.staffTelegramSession.findUnique.bind(db.staffTelegramSession);
      let calls = 0, snapshots = 0;
      const reader = vi.spyOn(db.staffTelegramSession, 'findUnique').mockImplementation(async args => {
        const index = ++calls;
        const row = await find(args);
        if (index <= 2) {
          if (++snapshots === 2) ready.resolve();
          await ready.promise;
        }
        return row;
      });
      fetcher.mockClear();
      try {
        await Promise.all([
          f.flow.resume(f.identity.id, f.telegramId),
          services().flow.resume(f.identity.id, f.telegramId),
        ]);
      } finally { ready.resolve(); reader.mockRestore(); }
      const current = await session(f);
      expect(current.updatedAt).toEqual(original.updatedAt);
      expect(current.confirmationCode).not.toBe(original.confirmationCode);
      expect(current.promptMessageId).not.toBe(original.promptMessageId);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await f.bot.handle(message(f, 'stale', original.promptMessageId!));
      expect(await session(f)).toEqual(current);
      await reply(f, 'сервис');
      expect((await session(f)).step).toBe('quantity');
    });
  });

  it('a delayed next-step response cannot overwrite the prompt bound by resume', async () => {
    const f = await fixture();
    await f.flow.start(f.identity.id, f.telegramId, 44, f.order.id, null, 'EXTRA', 'title');
    const oldPrompt = (await session(f)).promptMessageId!;
    const sent = gate<void>(), response = gate<Response>();
    fetcher.mockImplementationOnce(() => { sent.resolve(); return response.promise; });
    const input = f.bot.handle(message(f, 'сервис', oldPrompt));
    try {
      await sent.promise;
      expect(await session(f)).toMatchObject({ step: 'quantity', promptMessageId: null });
      await services().flow.resume(f.identity.id, f.telegramId);
      const current = await session(f);
      response.resolve(Response.json({ ok: true, result: { message_id: 8300 } }));
      await input;
      expect(await session(f)).toEqual(current);
      await f.bot.handle(message(f, '999', 8300));
      await f.bot.handle(message(f, '999', oldPrompt));
      expect(await session(f)).toEqual(current);
      await reply(f, '2');
      expect(await session(f)).toMatchObject({ step: 'price', payload: { title: 'сервис', quantity: 2 } });
    } finally {
      response.resolve(Response.json({ ok: false }));
      await Promise.allSettled([input]);
    }
  });

  it.each(['edit', 'send'])('keeps confirmation after unknown %s and fences its old button on resume', async mode => {
    const f = await fixture();
    await f.bot.handle(callback(f, staffData(f.order.id, 'x')));
    for (const value of ['сервис', '2', '123,45']) await reply(f, value);
    if (mode === 'send') await db.staffTelegramSession.update({
      where: { identityId: f.identity.id }, data: { dashboardMessageId: null },
    });
    fetcher.mockRejectedValueOnce(new Error('Synthetic lost confirmation response'));
    await reply(f, '-');
    const original = await session(f);
    expect(original).toMatchObject({ step: 'CONFIRM', payload: { title: 'сервис', unitPrice: 12345 } });
    await services().flow.resume(f.identity.id, f.telegramId);
    const current = await session(f);
    expect(current.confirmationCode).not.toBe(original.confirmationCode);
    await f.bot.handle(callback(f, staffConfirmData(f.order.id, 'xs', original.confirmationCode!)));
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(0);
    await f.bot.handle(callback(f, staffConfirmData(f.order.id, 'xs', current.confirmationCode!)));
    expect(await audits(f, 'EXTRA_ADD')).toHaveLength(1);
    expect(await pending(f)).toBeNull();
  });

});
