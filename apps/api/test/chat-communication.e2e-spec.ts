import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import sharp from 'sharp';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AppModule } from '../src/app.module.js';
import { NotificationService } from '../src/order/notification.service.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { SID } from '../src/auth/auth.service.js';

describe.skipIf(!process.env.DATABASE_URL)('chat communication / local PostgreSQL', () => {
  const schema = `chat_notice_test_${randomUUID().replaceAll('-', '')}`;
  let connection: pg.Client;
  let db: PrismaClient;
  let app: INestApplication<Server>;
  let created = false;
  let directory = '';
  let customer: { id: number; cookie: string }, seller: typeof customer, admin: typeof customer, stranger: typeof customer;
  let order: { id: number; publicId: string };
  let image: Buffer;
  const fetcher = vi.fn<typeof fetch>();
  async function session(role: 'USER' | 'SELLER' | 'ADMIN', phone: string) {
    const user = await db.user.create({ data: { role, phone } });
    const token = randomBytes(32).toString('hex');
    await db.session.create({ data: { userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600000) } });
    return { id: user.id, cookie: `${SID}=${token}` };
  }
  const customerPath = () => `/api/orders/${order.publicId}`;
  const staffPath = () => `/api/staff/orders/${order.id}`;
  const post = (path: string, cookie: string, text = 'Выберите этот продукт', requestId = randomUUID()) =>
    request(app.getHttpServer()).post(path + '/messages').set('Cookie', cookie).send({ text, requestId });
  const photo = (path: string, cookie: string) => request(app.getHttpServer()).post(path + '/messages/image')
    .set('Cookie', cookie).field('requestId', randomUUID()).attach('file', image, { filename: 'market.png', contentType: 'image/png' });
  const revise = (path: string, cookie: string, messageId: number, requestId = randomUUID()) =>
    request(app.getHttpServer()).post(`${path}/messages/${messageId}/revisions`).set('Cookie', cookie)
      .field('requestId', requestId).field('text', 'Вот этот')
      .attach('file', image, { filename: 'marked.png', contentType: 'image/png' });
  const events = () => db.orderNotification.findMany({ where: { orderId: order.id, channel: { not: 'IN_APP' } }, orderBy: { id: 'asc' } });
  const sent = () => fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as {
    chat_id: string; text: string; reply_markup: { inline_keyboard: { text: string; url?: string; web_app?: { url: string } }[][] };
  });
  const settled = () => vi.waitFor(async () => expect((await events()).every(row => !['PENDING', 'SENDING'].includes(row.status))).toBe(true));
  async function linkStaff() {
    for (const [user, telegramUserId] of [[seller, 9101n], [admin, 9102n]] as const)
      await db.staffTelegramIdentity.create({ data: { userId: user.id, telegramUserId, botStartedAt: new Date() } });
  }
  async function linkCustomer() {
    await db.telegramIdentity.create({ data: { userId: customer.id, telegramUserId: 9103n, customerBotStartedAt: new Date() } });
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local test database required');
    vi.stubEnv('ADMIN_PHONE', '+79990000802');
    vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', 'test-staff-token');
    vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', 'test-customer-token');
    vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', 'test_staff_secret');
    vi.stubEnv('TELEGRAM_CUSTOMER_WEBHOOK_SECRET', 'test_customer_secret');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
    vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', '');
    vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
    vi.stubGlobal('fetch', fetcher);
    directory = await mkdtemp(join(tmpdir(), 'shop-chat-notice-'));
    vi.stubEnv('CHAT_UPLOAD_DIR', directory);
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^chat_notice_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
    await connection.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DbService).useValue(db)
      .overrideProvider(TelegramService).useValue({ notifyNewOrder: async () => {} }).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    customer = await session('USER', '+79990000800'); seller = await session('SELLER', '+79990000801');
    admin = await session('ADMIN', '+79990000802'); stranger = await session('USER', '+79990000803');
    image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f43f5e' } }).png().toBuffer();
  }, 60000);
  beforeEach(async () => {
    await db.order.deleteMany();
    await db.staffTelegramIdentity.deleteMany();
    await db.telegramIdentity.deleteMany();
    await db.user.update({ where: { id: customer.id }, data: { role: 'USER' } });
    fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1 } }));
    order = await db.order.create({ data: { userId: customer.id, type: 'PICKUP', status: 'ASSEMBLING',
      customerName: 'Тест', customerPhone: '+79990000800', subtotal: 0 } });
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^chat_notice_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end();
    if (directory && /^shop-chat-notice-[^\\/]+$/.test(relative(tmpdir(), directory))) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  }, 30000);

  it('CUSTOMER notifies linked SELLER and ADMIN through STAFF bot after commit, excluding the author', async () => {
    await linkStaff(); await linkCustomer();
    await db.user.update({ where: { id: customer.id }, data: { role: 'SELLER' } });
    await db.staffTelegramIdentity.create({ data: { userId: customer.id, telegramUserId: 9199n, botStartedAt: new Date() } });
    const result = await post(customerPath(), customer.cookie).expect(201);
    await settled();
    expect(sent().map(body => body.chat_id)).toEqual(['9101', '9102']);
    expect((await events()).map(row => row.channel)).toEqual(['STAFF_TELEGRAM', 'STAFF_TELEGRAM']);
    for (const body of sent()) {
      expect(body.text).toContain(`Новое сообщение от покупателя\nЗаказ №${order.id}`);
      expect(body.reply_markup.inline_keyboard[0]?.[0]).toEqual({ text: 'Открыть чат',
        url: `https://shop.example/staff/orders/${order.id}?chatMessage=${result.body.id}#order-chat` });
    }
  });

  it.each(['SELLER', 'ADMIN'] as const)('%s notifies only CUSTOMER with an exact web chat link', async role => {
    await linkStaff(); await linkCustomer();
    const result = await post(staffPath(), role === 'SELLER' ? seller.cookie : admin.cookie, 'Текст '.repeat(100)).expect(201);
    await settled();
    expect(sent()).toHaveLength(1); expect(sent()[0]?.chat_id).toBe('9103');
    expect(sent()[0]?.text).toContain('Новое сообщение от продавца');
    expect(sent()[0]!.text.length).toBeLessThan(350);
    expect(sent()[0]?.reply_markup.inline_keyboard[0]?.[0]).toEqual({ text: 'Открыть чат', web_app: {
      url: 'https://shop.example/telegram?returnTo=' + encodeURIComponent(`/order/${order.publicId}?chatMessage=${result.body.id}#order-chat`) } });
  });

  it('concurrent HTTP retries persist one text message and one push per recipient', async () => {
    await linkStaff();
    const key = randomUUID();
    const [first, retry] = await Promise.all([post(customerPath(), customer.cookie, 'Выбор', key), post(customerPath(), customer.cookie, 'Выбор', key)]);
    expect(first.status).toBe(201); expect(retry.status).toBe(201); expect(retry.body.id).toBe(first.body.id);
    await settled();
    expect(await db.orderChatMessage.count()).toBe(1); expect(await events()).toHaveLength(2); expect(sent()).toHaveLength(2);
    await post(customerPath(), customer.cookie, 'Другой текст', key).expect(409);
    await post(customerPath(), stranger.cookie, 'Выбор', key).expect(404);
    await request(app.getHttpServer()).post(customerPath() + '/messages').set('Cookie', customer.cookie)
      .send({ text: 'Без ключа' }).expect(400);
  });

  it('unlinked recipients do not break either chat direction', async () => {
    await post(customerPath(), customer.cookie).expect(201);
    await post(staffPath(), seller.cookie).expect(201);
    await settled();
    expect(await db.orderChatMessage.count()).toBe(2); expect(sent()).toHaveLength(0);
    expect((await events())[0]?.status).toBe('UNCONFIGURED');
  });

  it('does not notify a staff author who is also the customer owning the order', async () => {
    await linkCustomer();
    await db.user.update({ where: { id: customer.id }, data: { role: 'SELLER' } });
    await post(staffPath(), customer.cookie).expect(201);
    expect(await db.orderChatMessage.count()).toBe(1); expect(await events()).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a photo revision after Telegram failure, including its unread state and idempotency', async () => {
    const original = await photo(staffPath(), seller.cookie).expect(201); await settled();
    await linkStaff(); fetcher.mockRejectedValue(new Error('test network failure'));
    const key = randomUUID();
    await revise(customerPath(), customer.cookie, original.body.id, key).expect(201);
    await vi.waitFor(async () => expect((await events()).filter(row => row.type === 'CHAT_IMAGE_REVISION')
      .every(row => row.status === 'SENDING')).toBe(true));
    await revise(customerPath(), customer.cookie, original.body.id, key).expect(201);
    expect(await db.orderChatMessage.count()).toBe(1); expect(await db.orderChatImageRevision.count()).toBe(2);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).staffUnread).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('an uncertain Telegram failure keeps the committed message and is never blindly resent', async () => {
    await linkStaff(); fetcher.mockRejectedValue(new Error('test transport failure'));
    const key = randomUUID();
    const first = await post(customerPath(), customer.cookie, 'Сохранить', key).expect(201);
    await vi.waitFor(async () => expect((await events()).every(row => row.status === 'SENDING')).toBe(true));
    await post(customerPath(), customer.cookie, 'Сохранить', key).expect(201);
    await app.get(NotificationService).dispatchStaffChat(order.id);
    expect(await db.orderChatMessage.findUnique({ where: { id: first.body.id } })).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(await events()).toHaveLength(2);
  });

  it('explicit rate-limit rejection retries through the durable sweep without duplicate rows', async () => {
    await linkCustomer(); fetcher.mockResolvedValue(Response.json({ ok: false, error_code: 429 }, { status: 429 }));
    await post(staffPath(), seller.cookie).expect(201);
    await vi.waitFor(async () => expect((await events())[0]).toMatchObject({ status: 'FAILED', error: 'TELEGRAM_RETRYABLE', attempts: 1 }));
    await db.orderNotification.updateMany({ where: { orderId: order.id }, data: { retryAt: new Date(Date.now() - 1000) } });
    fetcher.mockImplementation(async () => Response.json({ ok: true, result: { message_id: 2 } }));
    const notices = app.get(NotificationService) as unknown as { sweep(): Promise<void> };
    await notices.sweep(); await notices.sweep();
    expect(await events()).toHaveLength(1); expect((await events())[0]).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['customer', 'staff'] as const)('%s rate limits respect persisted retry_after across worker restarts', async side => {
    if (side === 'customer') await linkCustomer(); else await linkStaff();
    fetcher.mockImplementation(async () => Response.json({ ok: false, error_code: 429,
      parameters: { retry_after: 1800 } }, { status: 429 }));
    const before = Date.now();
    await post(side === 'customer' ? staffPath() : customerPath(), side === 'customer' ? seller.cookie : customer.cookie).expect(201);
    await vi.waitFor(async () => expect((await events()).every(row => row.status === 'FAILED')).toBe(true));
    const rows = await events();
    expect(rows.length).toBe(side === 'customer' ? 1 : 2);
    expect(rows.every(row => row.retryAt && row.retryAt.getTime() >= before + 1800_000)).toBe(true);
    await db.orderNotification.updateMany({ where: { orderId: order.id }, data: { updatedAt: new Date(before - 3600_000) } });
    const original = app.get(NotificationService);
    const restarted = new NotificationService(db as unknown as DbService,
      original['sms'], original['telegram']);
    const notices = restarted as unknown as { sweep(): Promise<void> };
    await notices.sweep();
    expect(fetcher).toHaveBeenCalledTimes(rows.length);
    fetcher.mockImplementation(async () => Response.json({ ok: true, result: { message_id: 2 } }));
    await db.orderNotification.updateMany({ where: { orderId: order.id }, data: { retryAt: new Date(Date.now() - 1000) } });
    await notices.sweep(); await notices.sweep();
    expect((await events()).every(row => row.status === 'SENT' && row.attempts === 2 && row.retryAt === null)).toBe(true);
    expect(await events()).toHaveLength(rows.length);
    expect(fetcher).toHaveBeenCalledTimes(rows.length * 2);
  });

  it('photo revisions notify only the counterpart and retries keep the same message and push', async () => {
    await linkStaff(); await linkCustomer();
    const original = await photo(staffPath(), seller.cookie).expect(201); await settled();
    await db.orderNotification.deleteMany(); fetcher.mockClear();
    const key = randomUUID();
    const first = await revise(customerPath(), customer.cookie, original.body.id, key).expect(201);
    const retry = await revise(customerPath(), customer.cookie, original.body.id, key).expect(201);
    expect(first.body.id).toBe(original.body.id); expect(retry.body.imageRevision).toBe(1);
    await settled(); expect(sent()).toHaveLength(2);
    expect(sent().every(body => body.text.includes('Покупатель отметил фото'))).toBe(true);
    expect(sent()[0]?.reply_markup.inline_keyboard[0]?.[0]?.url).toContain(`chatMessage=${original.body.id}#order-chat`);
    const reverse = await revise(staffPath(), admin.cookie, original.body.id).expect(201);
    await settled(); expect(reverse.body.imageRevision).toBe(2);
    expect(sent().at(-1)?.chat_id).toBe('9103'); expect(sent().at(-1)?.text).toContain('Продавец отметил фото');
    expect(await db.orderChatMessage.count()).toBe(1);
    expect(await db.orderChatImageRevision.count()).toBe(3);
    expect((await events()).every(row => row.type === 'CHAT_IMAGE_REVISION')).toBe(true);
    expect(await events()).toHaveLength(3);
  });

  it('in-app image revision events keep the original focus target and dedupe independently of Telegram', async () => {
    const original = await photo(staffPath(), seller.cookie).expect(201); await settled();
    await db.orderNotification.updateMany({ where: { channel: 'IN_APP' }, data: { seenAt: new Date() } });
    const key = randomUUID();
    for (let i = 0; i < 2; i++) await revise(customerPath(), customer.cookie, original.body.id, key).expect(201);
    const customerFeed = await request(app.getHttpServer()).get('/api/notifications').set('Cookie', customer.cookie).expect(200);
    expect(customerFeed.body.events).toEqual([]);
    for (const staff of [seller, admin]) {
      const feed = await request(app.getHttpServer()).get('/api/notifications').set('Cookie', staff.cookie).expect(200);
      expect(feed.body.events).toHaveLength(1);
      expect(feed.body.events[0]).toMatchObject({ kind: 'CHAT_IMAGE_REVISION',
        to: `/staff/orders/${order.id}?chatMessage=${original.body.id}#order-chat` });
    }
    await revise(staffPath(), admin.cookie, original.body.id).expect(201);
    const reverse = await request(app.getHttpServer()).get('/api/notifications').set('Cookie', customer.cookie).expect(200);
    expect(reverse.body.events).toHaveLength(1);
    expect(reverse.body.events[0]).toMatchObject({ kind: 'CHAT_IMAGE_REVISION',
      to: `/order/${order.publicId}?chatMessage=${original.body.id}#order-chat` });
    expect(await db.orderChatMessage.count()).toBe(1);
    expect(await db.orderChatImageRevision.count()).toBe(3);
  });

  it('loads an old exact message outside the initial 30 with the latest photo revision and protects access', async () => {
    const original = await photo(staffPath(), seller.cookie).expect(201); await settled();
    await revise(customerPath(), customer.cookie, original.body.id).expect(201);
    await revise(staffPath(), admin.cookie, original.body.id).expect(201); await settled();
    await db.orderChatMessage.createMany({ data: Array.from({ length: 65 }, (_, index) => ({
      orderId: order.id, authorType: 'SELLER' as const, recipient: 'customer', text: `История ${index}`,
    })) });
    const latest = await request(app.getHttpServer()).get(customerPath() + '/messages').set('Cookie', customer.cookie).expect(200);
    expect(latest.body.messages).toHaveLength(30);
    expect(latest.body.messages.some((row: { id: number }) => row.id === original.body.id)).toBe(false);
    const focused = await request(app.getHttpServer()).get(customerPath() + `/messages?around=${original.body.id}`)
      .set('Cookie', customer.cookie).expect(200);
    expect(focused.body.messages[0]).toMatchObject({ id: original.body.id, imageRevision: 2, revisionText: 'Вот этот', revisionActor: 'ADMIN' });
    const viewed = await request(app.getHttpServer()).post(customerPath() + '/messages/read').set('Cookie', customer.cookie)
      .send({ through: original.body.id, revisionThrough: focused.body.unreadRevision.id }).expect(201);
    expect(viewed.body.unreadMessage.id).toBeGreaterThan(original.body.id);
    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.customerReadMessageId).toBe(original.body.id);
    expect(saved.customerReadImageRevisionId).toBe(focused.body.unreadRevision.id);
    await request(app.getHttpServer()).get(customerPath() + `/messages?around=${original.body.id}`).set('Cookie', stranger.cookie).expect(404);
    const foreign = await db.order.create({ data: { type: 'PICKUP', customerName: 'Другой', customerPhone: '+79990000000', subtotal: 0 } });
    const message = await db.orderChatMessage.create({ data: { orderId: foreign.id, text: 'Private', authorType: 'CUSTOMER' } });
    await request(app.getHttpServer()).get(staffPath() + `/messages?around=${message.id}`).set('Cookie', seller.cookie).expect(404);
  });

  it('a staff revision of a CUSTOMER-authored photo is still a customer event, while its staff author gets none', async () => {
    const original = await photo(customerPath(), customer.cookie).expect(201);
    await db.orderNotification.updateMany({ where: { channel: 'IN_APP' }, data: { seenAt: new Date() } });
    const key = randomUUID();
    for (let i = 0; i < 2; i++) await revise(staffPath(), admin.cookie, original.body.id, key).expect(201);
    const feed = await request(app.getHttpServer()).get('/api/notifications').set('Cookie', customer.cookie).expect(200);
    expect(feed.body.events).toHaveLength(1);
    expect(feed.body.events[0]).toMatchObject({ kind: 'CHAT_IMAGE_REVISION',
      to: `/order/${order.publicId}?chatMessage=${original.body.id}#order-chat` });
    const own = await request(app.getHttpServer()).get('/api/notifications').set('Cookie', admin.cookie).expect(200);
    expect(own.body.events).toEqual([]);
    expect(await db.orderChatMessage.count()).toBe(1);
  });
});
