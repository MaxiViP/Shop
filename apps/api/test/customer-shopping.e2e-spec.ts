import { QuickShopService } from '../src/cart/quick-shop.service.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Unit } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { CartService } from '../src/cart/cart.service.js';
import { OrderService } from '../src/order/order.service.js';
import { CoordinationService } from '../src/order/coordination.service.js';
import { ChatImagesService } from '../src/order/chat-images.service.js';
import { NotificationService } from '../src/order/notification.service.js';
import { StaffService } from '../src/staff/staff.service.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { CustomerCheckoutService } from '../src/telegram/customer-checkout.service.js';
import { CustomerShopService } from '../src/telegram/customer-shop.service.js';
import { CustomerUpdateService } from '../src/telegram/customer-update.service.js';
import { receivingPayload } from '../src/telegram/receiving.js';
import { checkoutPayload } from '../src/telegram/checkout.js';
import { shoppingData, shoppingAction, productData, adjustData } from '../src/telegram/shopping-callback.js';
import { customerView } from '../src/telegram/customer-callback.js';
import type { InputRichBlock, InputRichMessage, RichText, RichMessageButton } from '../src/telegram/rich.js';

describe.skipIf(!process.env.DATABASE_URL)(
  'CUSTOMER shopping PostgreSQL',
  () => {
    const schema = 'customer_shop_test_' + randomUUID().replaceAll('-', '');
    let connection: pg.Client,
      db: PrismaClient,
      created = false;
    let cart: CartService,
      orders: OrderService,
      coordination: CoordinationService,
      checkout: CustomerCheckoutService,
      staff: StaffService;
    let seller: { userId: number; role: 'SELLER' };
    const notices = {
      dispatch: vi.fn().mockResolvedValue(undefined),
      dispatchTelegram: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotificationService;
    const telegram = {
      notifyNewOrder: vi.fn().mockResolvedValue(undefined),
      notifyPaymentReported: vi.fn().mockResolvedValue(undefined),
    };
    const fetcher = vi.fn<typeof fetch>();
    let messageId = 100;
    type Sent = {
      text?: string;
      parse_mode?: string;
      reply_markup?: {
        force_reply?: boolean;
        inline_keyboard?: {
          text: string;
          callback_data?: string;
          url?: string;
          web_app?: { url: string };
        }[][];
      };
    };
    const request = (init?: RequestInit): Sent & { rich_message?: InputRichMessage; message_id?: number } => init?.body instanceof FormData
      ? { rich_message: JSON.parse(String(init.body.get('rich_message'))), message_id: Number(init.body.get('message_id')) }
      : JSON.parse(String(init?.body));
    const captionButtons = (text: RichText): RichMessageButton[] => typeof text === 'string' ? [] : Array.isArray(text)
      ? text.flatMap(captionButtons) : text.type === 'button' ? [text.button] : captionButtons(text.text);
    const nativeRows = (blocks: InputRichBlock[]): { text: string; callback_data?: string }[][] => blocks.flatMap(block => block.type === 'buttons' ? [block.buttons]
      : block.type === 'table' ? block.cells.flatMap(row => row.map(cell => captionButtons(cell.text)))
      : block.type === 'photo' && block.caption ? [captionButtons(block.caption.text)]
      : block.type === 'collage' || block.type === 'details' ? nativeRows(block.blocks) : []);
    const sent = () =>
      fetcher.mock.calls.map(
        ([, init]) => {
          const value = request(init);
          // Assert visible semantics here; raw escaping/Rich payloads have dedicated transport tests.
          if (value.parse_mode === 'HTML' && value.text) value.text = value.text.replace(/<\/?b>/g, '')
            .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
          return value;
        },
      );
    const bot = () => {
      const typed = db as unknown as DbService;
      const flow = new CustomerCheckoutService(typed, cart, orders);
      return new CustomerUpdateService(
        typed,
        coordination,
        orders,
        new CustomerShopService(typed, cart, flow, orders, new QuickShopService(typed, cart)),
        flow,
      );
    };
    const cb = (id: number, data: string) => ({
      callback_query: {
        id: 'test-callback',
        data,
        from: { id, is_bot: false },
        message: { message_id: 5, chat: { id, type: 'private' } },
      },
    });
    const text = (id: number, value: string, reply?: number) => ({
      message: {
        message_id: 10,
        text: value,
        from: { id, is_bot: false },
        chat: { id, type: 'private' },
        ...(reply ? { reply_to_message: { message_id: reply } } : {}),
      },
    });
    beforeAll(async () => {
      const target = new URL(process.env.DATABASE_URL!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
        throw new Error('Local test database required');
      connection = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await connection.connect();
      if (!/^customer_shop_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema');
      await connection.query('CREATE SCHEMA "' + schema + '"');
      created = true;
      await connection.query('SET search_path TO "' + schema + '"');
      const root = resolve('prisma/migrations');
      for (const entry of (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '20260925120000_customer_shopping') {
          for (const [step, prompt] of [
            ['TEXT', 901],
            ['PROMPT', null],
          ] as const) {
            const u = await connection.query<{ id: number }>(
              'INSERT INTO "User" (name,"updatedAt") VALUES ($1,NOW()) RETURNING id',
              ['migration-fixture'],
            );
            const i = await connection.query<{ id: number }>(
              'INSERT INTO "TelegramIdentity" ("telegramUserId","userId","updatedAt") VALUES ($1,$2,NOW()) RETURNING id',
              [1234567 + u.rows[0]!.id, u.rows[0]!.id],
            );
            const o = await connection.query<{ id: number }>(
              `INSERT INTO "Order" (type,"customerName","customerPhone",subtotal,"userId","updatedAt")
                VALUES ('PICKUP','migration-fixture','+79990000001',10000,$1,NOW()) RETURNING id`,
              [u.rows[0]!.id],
            );
            await connection.query(
              `INSERT INTO "CustomerTelegramSession" (id,"identityId","orderId",action,step,"promptMessageId","expiresAt","updatedAt")
                VALUES ($1,$2,$3,'CHAT',$4,$5,NOW()+INTERVAL '1 hour',NOW())`,
              [randomUUID(), i.rows[0]!.id, o.rows[0]!.id, step, prompt],
            );
          }
        }
        await connection.query(
          await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
        );
      }
      // The test exercises checkout at any hour without depending on real Moscow time.
      await connection.query('UPDATE "ShopHours" SET "openMinutes" = 0, "closeMinutes" = 1440');
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: process.env.DATABASE_URL,
            options: '-c search_path=' + schema,
            application_name: schema,
          },
          { schema },
        ),
      });
      const typed = db as unknown as DbService;
      orders = new OrderService(typed, telegram as unknown as TelegramService);
      cart = new CartService(typed, orders);
      coordination = new CoordinationService(typed, orders, notices, new ChatImagesService());
      checkout = new CustomerCheckoutService(typed, cart, orders);
      staff = new StaffService(typed, notices);
      const user = await db.user.create({ data: { role: 'SELLER' } });
      seller = { userId: user.id, role: 'SELLER' };
    }, 60000);
    beforeEach(async () => {
      vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID());
      vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
      vi.stubEnv('PAYMENT_PHONE', 'test customer-visible requisite');
      vi.stubEnv('PAYMENT_CARD_NUMBER', '');
      vi.stubEnv('PAYMENT_QR_IMAGE_URL', '');
      vi.stubEnv('PAYMENT_SBP_LINK', '');
      fetcher
        .mockReset()
        .mockImplementation(async () =>
          Response.json({ ok: true, result: { message_id: ++messageId } }),
        );
      vi.stubGlobal('fetch', fetcher);
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      telegram.notifyNewOrder.mockClear();
      telegram.notifyPaymentReported.mockClear();
      await db.shopSettings.upsert({
        where: { id: 1 },
        create: { id: 1, minDeliverySubtotal: 0 },
        update: {
          minDeliverySubtotal: 0,
          pickupEnabled: true,
          deliveryEnabled: true,
        },
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      await db?.$disconnect();
      if (created && /^customer_shop_test_[a-f0-9]{32}$/.test(schema))
        await connection.query('DROP SCHEMA "' + schema + '" CASCADE');
      await connection?.end();
    }, 30000);
    async function fixture(unit: Unit = 'GRAM') {
      const user = await db.user.create({ data: { name: 'Покупатель' } });
      const telegramId = 800000 + user.id;
      const identity = await db.telegramIdentity.create({
        data: {
          userId: user.id,
          telegramUserId: BigInt(telegramId),
          phoneNumber: '+79990000003',
          phoneVerified: true,
          customerBotStartedAt: new Date(),
        },
      });
      const category = await db.category.create({
        data: { name: 'Категория', slug: randomUUID() },
      });
      const product = await db.product.create({
        data: {
          name: 'Продукт',
          slug: randomUUID(),
          categoryId: category.id,
          unit,
          price: 35000,
          priceQty: unit === 'GRAM' ? 1000 : 1,
          min: unit === 'GRAM' ? 500 : 1,
          step: unit === 'GRAM' ? 500 : 1,
          portionQty: unit === 'GRAM' ? 500 : 1,
        },
      });
      return {
        user,
        identity,
        telegramId,
        product,
        category,
        actor: { id: identity.id, userId: user.id },
      };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const session = (f: Fixture) =>
      db.customerTelegramSession.findUniqueOrThrow({
        where: { identityId: f.identity.id },
      });
    async function add(f: Fixture, qty = f.product.min) {
      const c = await cart.get(f.user.id);
      return cart.change(f.user.id, c.revision, {
        kind: 'add',
        productId: f.product.id,
        qty,
      });
    }
    async function bind(f: Fixture) {
      const s = await session(f);
      return db.customerTelegramSession.update({
        where: { id: s.id },
        data: { promptMessageId: ++messageId },
      });
    }
    async function ready(f: Fixture, type: 'PICKUP' | 'DELIVERY' = 'PICKUP') {
      const c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      s = await checkout.choose(
        f.actor,
        s.id,
        type === 'PICKUP' ? 'pickup' : 'delivery',
      );
      // The verified own Telegram phone is a valid checkout default; another recipient is edited explicitly.
      expect(checkoutPayload.parse(s.payload).customerPhone).toBe(f.identity.phoneNumber);
      expect(s.step).toBe(type === 'DELIVERY' ? 'ADDRESS' : 'TIME');
      if (type === 'DELIVERY') {
        await db.address.create({
          data: {
            userId: f.user.id,
            label: 'Дом',
            city: 'Москва',
            street: 'Улица',
            house: '1',
          },
        });
        s = await checkout.choose(f.actor, s.id, 'new');
        for (const value of [
          'Москва',
          'Улица',
          '1',
          '-',
          '-',
          '-',
          '-',
          'У двери',
        ]) {
          s = await bind(f);
          s = await checkout.reply(f.actor, value, s.promptMessageId!);
        }
      }
      expect(s.step).toBe('TIME');
      s = await bind(f);
      return checkout.reply(f.actor, '-', s.promptMessageId!);
    }
    async function paidReady(f: Fixture) {
      const s = await ready(f);
      const o = await checkout.confirm(f.actor, s.id);
      await staff.confirm(o.id, seller);
      await staff.startAssembly(o.id, seller);
      const item = await db.orderItem.findFirstOrThrow({
        where: { orderId: o.id },
      });
      await staff.item(
        o.id,
        item.id,
        { status: 'PICKED', actualQty: item.qty },
        seller.userId,
        seller,
      );
      await staff.finishAssembly(o.id, seller);
      return o;
    }

    it.each([
      { unit: 'GRAM', rich: true, min: 500, step: 100, variable: false },
      { unit: 'PIECE', rich: false, min: 1, step: 1, variable: false },
      { unit: 'PACK', rich: false, min: 2, step: 1, variable: false },
      { unit: 'BUNCH', rich: false, min: 3, step: 1, variable: false },
      { unit: 'PIECE', rich: true, min: 1, step: 1, variable: true },
    ] satisfies { unit: Unit; rich: boolean; min: number; step: number; variable: boolean }[])(
      'direct category $unit/$variable Rich=$rich binds min/step and ignores duplicate/stale actions on the same page', async spec => {
        const f = await fixture(spec.unit), handler = bot(), directory = await mkdtemp(join(tmpdir(), 'category-ux34-'));
        const config = join(directory, 'policy.json');
        await writeFile(config, JSON.stringify({ enabled: spec.rich, global: { customer: true } })); vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', config);
        await db.product.update({ where: { id: f.product.id }, data: { min: spec.min, step: spec.step, sort: 100,
          name: 'Очень длинное название продукции '.repeat(8),
          ...(spec.variable ? { saleModel: 'WHOLE_VARIABLE_WEIGHT', priceUnit: 'GRAM', priceQty: 1000, estimatedWeightGrams: null } : {}) } });
        await db.product.createMany({ data: Array.from({ length: 8 }, (_, index) => ({ name: 'Другой товар ' + index,
          slug: randomUUID(), categoryId: f.category.id, price: 11000, unit: 'PIECE', min: 1, step: 1, portionQty: 1 })) });
        const payloads = () => fetcher.mock.calls.map(([, init]) => request(init));
        const fixedAdd = () => {
          const payload = payloads().filter(payload => payload.rich_message || payload.parse_mode === 'HTML').at(-1);
          const rows = payload?.reply_markup?.inline_keyboard ?? nativeRows(payload?.rich_message?.blocks ?? []);
          const row = rows.find((row: { callback_data?: string }[]) => row.some(button => {
            const action = shoppingAction(button.callback_data ?? '');
            return action?.kind === 'open' && action.productId === f.product.id;
          }))?.slice(0, 2);
          expect(row).toHaveLength(2);
          expect(row![1]!.text).toBe('Добавить в 🛒');
          expect(shoppingAction(row![1]!.callback_data!)).toMatchObject({ kind: 'adjust', productId: f.product.id, inCategory: true, page: 1 });
          if (spec.rich) {
            const blocks = payload!.rich_message!.blocks;
            const actual = blocks.filter(block => block.type === 'buttons').flatMap(block => block.buttons);
            expect(actual).toContainEqual(expect.objectContaining({ text: 'Добавить в 🛒', callback_data: row![1]!.callback_data }));
            expect(row![0]!.text).toMatch(/^Слева · /);
            for (const block of blocks) if (block.type === 'collage') {
              expect(block.blocks).toHaveLength(2);
              for (const photo of block.blocks) expect(photo).not.toHaveProperty('caption');
            }
          }
        };
        const button = (delta: number) => {
          const buttons = payloads().flatMap(payload => payload.reply_markup?.inline_keyboard?.flat() ?? nativeRows(payload.rich_message?.blocks ?? []).flat()).reverse();
          const found = buttons.find((button: { callback_data?: string }) => {
            const action = shoppingAction(button.callback_data ?? '');
            return action?.kind === 'adjust' && action.inCategory && action.productId === f.product.id && action.delta === delta;
          });
          if (!found?.callback_data) throw new Error('Bound category callback missing');
          return found.callback_data as string;
        };
        try {
          await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 1)));
          fixedAdd();
          const write = vi.spyOn(cart, 'change'), first = button(spec.min);
          const update = { ...cb(f.telegramId, first), update_id: 4000000 + f.user.id * 10 };
          await Promise.all([handler.handle(update), handler.handle(update)]);
          expect(write).toHaveBeenCalledTimes(1); expect((await cart.get(f.user.id)).items[0]?.qty).toBe(spec.min);
          fixedAdd();
          await handler.handle(cb(f.telegramId, first));
          expect(write).toHaveBeenCalledTimes(1);
          const plus = button(spec.step);
          await Promise.all([handler.handle(cb(f.telegramId, plus)), handler.handle(cb(f.telegramId, plus))]);
          expect(write).toHaveBeenCalledTimes(2); expect((await cart.get(f.user.id)).items[0]?.qty).toBe(spec.min + spec.step);
          fixedAdd();
          await handler.handle(cb(f.telegramId, button(-spec.step)));
          expect((await cart.get(f.user.id)).items[0]?.qty).toBe(spec.min);
          fixedAdd();
          const last = payloads().filter(payload => payload.rich_message || payload.parse_mode === 'HTML').at(-1);
          expect(JSON.stringify(last)).toContain('Страница 2 из 2');
          expect(JSON.stringify(last)).toContain(shoppingData('l', f.category.id, 0));
          expect(JSON.stringify(last)).toContain(productData(f.product.id, { origin: 'category', categoryId: f.category.id, page: 1 }));
          expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
        } finally { await rm(directory, { recursive: true, force: true }); }
      });
    it.each(['GRAM', 'PIECE'] as const)('accepted table gallery keeps %s mutations, returns, stale checks and configuration rollback', async unit => {
      const f = await fixture(unit), handler = bot(), directory = await mkdtemp(join(tmpdir(), 'gallery-table-'));
      const config = join(directory, 'policy.json'), name = 'Длинное полное название продукта '.repeat(8);
      await db.product.update({ where: { id: f.product.id }, data: { name } });
      await db.product.create({ data: { name: 'Второй товар', slug: randomUUID(), categoryId: f.category.id,
        price: 11000, unit: 'PIECE', min: 1, step: 1, portionQty: 1 } });
      await writeFile(config, JSON.stringify({ enabled: true, global: { customer: true }, customerGalleryTables: [String(f.telegramId)] }));
      vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', config);
      const latest = () => fetcher.mock.calls.map(([, init]) => request(init)).filter(value => value.rich_message || value.parse_mode === 'HTML').at(-1)!;
      const table = () => {
        const found = latest().rich_message?.blocks.find(block => block.type === 'table');
        if (found?.type !== 'table') throw new Error('Native table missing');
        expect(found.cells.map(row => row.length)).toEqual([2, 2]);
        return found;
      };
      const adjust = (delta: number) => {
        const found = nativeRows(latest().rich_message?.blocks ?? []).flat().find(button => {
          const action = shoppingAction(button.callback_data ?? '');
          return action?.kind === 'adjust' && action.productId === f.product.id && action.delta === delta;
        });
        if (!found?.callback_data) throw new Error('Table adjustment missing');
        return found.callback_data;
      };
      try {
        await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
        expect(JSON.stringify(table().cells[0]![0])).toContain(name);
        expect(captionButtons(table().cells[1]![0]!.text)[0]?.text).toBe('Добавить в ');
        expect(latest().rich_message?.blocks.filter(block => block.type === 'collage').every(block => block.blocks.length === 2)).toBe(true);
        const write = vi.spyOn(cart, 'change'), first = adjust(f.product.min);
        const update = { ...cb(f.telegramId, first), update_id: 9000000 + f.user.id };
        await Promise.all([handler.handle(update), handler.handle(update)]);
        expect(write).toHaveBeenCalledTimes(1); expect((await cart.get(f.user.id)).items[0]?.qty).toBe(f.product.min);
        expect(JSON.stringify(table().cells[0]![0])).toContain('🛒');
        expect(captionButtons(table().cells[0]![0]!.text).map(button => button.text)).toContain('+');
        await handler.handle(cb(f.telegramId, first)); expect(write).toHaveBeenCalledTimes(1);
        await handler.handle(cb(f.telegramId, adjust(f.product.step)));
        expect((await cart.get(f.user.id)).items[0]?.qty).toBe(f.product.min + f.product.step);
        const minus = adjust(-f.product.step);
        await handler.handle(cb(f.telegramId, minus)); expect((await cart.get(f.user.id)).items[0]?.qty).toBe(f.product.min);
        const open = captionButtons(table().cells[0]![0]!.text)[0]!;
        if (!('callback_data' in open)) throw new Error('Open callback missing');
        await handler.handle(cb(f.telegramId, open.callback_data));
        expect(JSON.stringify(latest())).toContain('← К товарам');
        await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 0))); table();
        const saved = adjust(f.product.step);
        await writeFile(config, JSON.stringify({ enabled: true, global: { customer: true }, customerGalleryTables: [] }));
        await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
        expect(latest().rich_message?.blocks.some(block => block.type === 'table')).toBe(false);
        expect(latest().rich_message?.blocks.some(block => block.type === 'buttons' && block.buttons.some(button => button.text === 'Добавить в 🛒'))).toBe(true);
        await writeFile(config, '{"enabled":false}');
        await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
        expect(latest()).toMatchObject({ parse_mode: 'HTML' }); expect(latest().reply_markup?.inline_keyboard?.flat().some(button => button.callback_data === saved)).toBe(true);
        const count = write.mock.calls.length;
        await db.telegramIdentity.update({ where: { id: f.identity.id }, data: { phoneVerified: false } });
        await handler.handle(cb(f.telegramId, saved)); expect(write).toHaveBeenCalledTimes(count);
        expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
    it('requires own phone verification instead of mutating the basket from a saved category callback', async () => {
      const f = await fixture('PIECE'), handler = bot();
      await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
      const buttons = sent().flatMap(screen => screen.reply_markup?.inline_keyboard?.flat() ?? []);
      const add = buttons.find(button => {
        const action = shoppingAction(button.callback_data ?? ''); return action?.kind === 'adjust' && action.inCategory;
      });
      if (!add?.callback_data) throw new Error('Direct add callback missing');
      await db.telegramIdentity.update({ where: { id: f.identity.id }, data: { phoneVerified: false } });
      const write = vi.spyOn(cart, 'change'), read = vi.spyOn(cart, 'get'); fetcher.mockClear();
      await handler.handle(cb(f.telegramId, add.callback_data));
      expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(sent())).toContain('request_contact');
      expect((await cart.get(f.user.id)).items).toHaveLength(0);
    });

    it('global Rich preserves catalog, min/step, cart, checkout and immediate HTML rollback outside the old allowlist', async () => {
      const f = await fixture('GRAM'), handler = bot(), directory = await mkdtemp(join(tmpdir(), 'customer-rich-global-'));
      const config = join(directory, 'policy.json');
      await writeFile(config, JSON.stringify({ enabled: true, customer: ['123'], global: { customer: true } }));
      vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', config);
      const payloads = () => fetcher.mock.calls.map(([, init]) => request(init));
      const choice = (kind: 'adjust' | 'checkout' | 'flow', value?: 'pickup' | 'confirm') => {
        const buttons = payloads().flatMap(payload => nativeRows(payload.rich_message?.blocks ?? []).flat()).reverse();
        const found = buttons.find((button: { callback_data?: string }) => {
          const action = shoppingAction(button.callback_data ?? '');
          return action?.kind === kind && (action.kind !== 'flow' || action.choice === value);
        });
        if (!found?.callback_data) throw new Error('Rich callback missing');
        return found.callback_data as string;
      };
      try {
        await handler.handle(text(f.telegramId, '/catalog'));
        await handler.handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
        await handler.handle(cb(f.telegramId, productData(f.product.id, { origin: 'category', categoryId: f.category.id, page: 0 })));
        await handler.handle(cb(f.telegramId, choice('adjust')));
        expect((await cart.get(f.user.id)).items[0]?.qty).toBe(f.product.min);
        await handler.handle(cb(f.telegramId, 'cart'));
        const cartPayload = payloads().filter(payload => payload.rich_message).at(-1)!;
        const cartRows = cartPayload.rich_message!.blocks.filter(block => block.type === 'buttons' && block.buttons.some(button => button.text === '✕'));
        expect(cartRows).toHaveLength(1);
        expect(cartRows[0]).toMatchObject({ align: 'right', buttons: [expect.objectContaining({ callback_data: expect.any(String) }),
          expect.objectContaining({ text: '−' }), expect.objectContaining({ text: '+' }), expect.objectContaining({ text: '✕' })] });
        await handler.handle(cb(f.telegramId, choice('checkout')));
        await handler.handle(cb(f.telegramId, choice('flow', 'pickup')));
        const state = await session(f); expect(state.step).toBe('TIME');
        await handler.handle(text(f.telegramId, '-', state.promptMessageId!));
        const confirmation = choice('flow', 'confirm');
        await handler.handle(cb(f.telegramId, confirmation));
        await handler.handle(cb(f.telegramId, confirmation));
        expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
        const order = await db.order.findFirstOrThrow({ where: { userId: f.user.id }, include: { items: true } });
        expect(order.items[0]?.qty).toBe(f.product.min); expect(order.items[0]?.price).toBeGreaterThan(0);
        expect(payloads().filter(payload => payload.rich_message).length).toBeGreaterThanOrEqual(7);
        await writeFile(config + '.next', '{"enabled":false}'); await rename(config + '.next', config);
        await handler.handle(cb(f.telegramId, 'cart'));
        const last = payloads().filter(payload => payload.parse_mode === 'HTML').at(-1);
        expect(last).toMatchObject({ message_id: 5, parse_mode: 'HTML' }); expect(last).not.toHaveProperty('rich_message');
        expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('native single-step buttons keep acknowledged quantities across card/basket and deduplicate one Telegram update', async () => {
      const f = await fixture('BUNCH');
      await db.product.update({ where: { id: f.product.id }, data: {
        name: 'Укроп', price: 15000, serviceMarkupPercent: 10, saleModel: 'BUNCH', priceUnit: 'BUNCH',
      } });
      const handler = bot(), context = { page: 2, origin: 'category' as const };
      const button = (delta: number) => {
        const candidates = sent().flatMap(screen => screen.reply_markup?.inline_keyboard?.flat() ?? []).reverse();
        const found = candidates.find(button => {
          const action = shoppingAction(button.callback_data ?? '');
          return action?.kind === 'adjust' && action.productId === f.product.id && action.delta === delta;
        });
        if (!found?.callback_data) throw new Error('Immediate action not rendered');
        return found.callback_data;
      };
      await handler.handle(cb(f.telegramId, productData(f.product.id, context)));
      let sequence = 1000000 + f.user.id * 10;
      for (const [delta, expected] of [[1, 1], [1, 2], [1, 3], [-1, 2], [1, 3], [1, 4]] as const) {
        const update = { ...cb(f.telegramId, button(delta)), update_id: sequence++ };
        await Promise.all([handler.handle(update), handler.handle(update)]);
        const stored = await cart.get(f.user.id);
        expect(stored.items[0]?.qty).toBe(expected);
        expect(stored.items[0]?.lineTotal).toBe(expected * 16500);
      }
      await handler.handle(cb(f.telegramId, 'cart'));
      await handler.handle(cb(f.telegramId, productData(f.product.id, context)));
      expect((await cart.get(f.user.id)).items[0]?.qty).toBe(4);
      expect(sent().at(-2)?.text).toContain('4 пучка');
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('lost native-adjust response reads committed PostgreSQL state and never repeats the write', async () => {
      const f = await fixture('BUNCH'), handler = bot();
      const current = await cart.get(f.user.id), original = cart.change.bind(cart);
      const write = vi.spyOn(cart, 'change').mockImplementationOnce(async (...args) => {
        await original(...args); throw new Error('Lost response after cart commit');
      });
      const update = { ...cb(f.telegramId, adjustData(current.revision, f.product.id, 2, 'BUNCH', { page: 0, origin: 'category' })),
        update_id: 2000000 + f.user.id };
      await handler.handle(update); await handler.handle(update);
      expect(write).toHaveBeenCalledTimes(1);
      expect((await cart.get(f.user.id)).items[0]?.qty).toBe(2);
      expect(sent().some(screen => screen.text?.includes('Корзина перечитана'))).toBe(true);
    });
    it('creates one user-owned cart and never shares it with another user', async () => {
      const a = await fixture(),
        b = await fixture();
      await Promise.all([cart.get(a.user.id), cart.get(a.user.id)]);
      expect(await db.cart.count({ where: { userId: a.user.id } })).toBe(1);
      await add(a);
      expect((await cart.get(b.user.id)).items).toHaveLength(0);
    });
    it.each(['GRAM', 'PIECE', 'BUNCH', 'PACK'] as const)(
      'adds a single %s item, increments by step and clamps decrement at min',
      async (unit) => {
        const f = await fixture(unit);
        let c = await add(f);
        c = await cart.change(f.user.id, c.revision, {
          kind: 'plus',
          productId: f.product.id,
        });
        expect(c.items[0]!.qty).toBe(f.product.min + f.product.step);
        c = await cart.change(f.user.id, c.revision, {
          kind: 'minus',
          productId: f.product.id,
        });
        c = await cart.change(f.user.id, c.revision, {
          kind: 'minus',
          productId: f.product.id,
        });
        expect(c.items[0]!.qty).toBe(f.product.min);
        c = await cart.change(f.user.id, c.revision, {
          kind: 'add',
          productId: f.product.id,
          qty: f.product.min,
        });
        expect(c.items).toHaveLength(1);
      },
    );
    it('removes and clears only the expected revision', async () => {
      const f = await fixture();
      let c = await add(f);
      c = await cart.change(f.user.id, c.revision, {
        kind: 'remove',
        productId: f.product.id,
      });
      expect(c.items).toHaveLength(0);
      c = await add(f);
      c = await cart.change(f.user.id, c.revision, { kind: 'clear' });
      expect(c.items).toHaveLength(0);
    });
    it.each([0, -1, 501, 1000001, 1.5])(
      'rejects invalid quantity %s',
      async (qty) => {
        const f = await fixture(),
          c = await cart.get(f.user.id);
        await expect(
          cart.change(f.user.id, c.revision, {
            kind: 'add',
            productId: f.product.id,
            qty,
          }),
        ).rejects.toThrow();
        expect((await cart.get(f.user.id)).items).toHaveLength(0);
      },
    );
    it('rejects inactive products and quotes current prices', async () => {
      const f = await fixture();
      await add(f);
      await db.product.update({
        where: { id: f.product.id },
        data: { price: 70000 },
      });
      expect((await cart.get(f.user.id)).subtotal).toBe(38500);
      await db.product.update({
        where: { id: f.product.id },
        data: { active: false },
      });
      const c = await cart.get(f.user.id);
      expect(c.valid).toBe(false);
      await expect(
        cart.change(f.user.id, c.revision, {
          kind: 'plus',
          productId: f.product.id,
        }),
      ).rejects.toThrow();
    });
    it('concurrent duplicate increment changes quantity once; foreign/stale revision cannot edit', async () => {
      const f = await fixture(),
        c = await add(f);
      const attempts = await Promise.allSettled(
        [1, 2].map(() =>
          cart.change(f.user.id, c.revision, {
            kind: 'plus',
            productId: f.product.id,
          }),
        ),
      );
      expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((await cart.get(f.user.id)).items[0]!.qty).toBe(1000);
      const other = await fixture();
      await expect(
        cart.change(other.user.id, c.revision, { kind: 'clear' }),
      ).rejects.toThrow();
    });
    it.each(['PICKUP', 'DELIVERY'] as const)(
      '%s checkout creates a normal owned Order with authoritative snapshots',
      async (type) => {
        const f = await fixture();
        await db.product.update({ where: { id: f.product.id }, data: {
          settlementMode: 'SHARED_MARKUP', basePrice: 25000,
        } });
        const s = await ready(f, type);
        const o = await checkout.confirm(f.actor, s.id);
        const saved = await db.order.findUniqueOrThrow({
          where: { id: o.id },
          include: { items: true },
        });
        expect(saved).toMatchObject({
          userId: f.user.id,
          guestSessionId: null,
          type,
          status: 'NEW',
          subtotal: 19250,
        });
        expect(saved.items[0]).toMatchObject({
          price: 38500,
          priceQty: 1000,
          unit: 'GRAM',
          qty: 500,
          total: 19250,
          settlementModeSnapshot: 'SHARED_MARKUP',
          basePriceSnapshot: 25000,
        });
        if (type === 'DELIVERY')
          expect(saved).toMatchObject({
            city: 'Москва',
            street: 'Улица',
            house: '1',
            comment: 'У двери',
            deliveryPrice: null,
          });
        expect((await cart.get(f.user.id)).items).toHaveLength(0);
        expect(
          await db.customerTelegramSession.findUnique({
            where: { identityId: f.identity.id },
          }),
        ).toBeNull();
        expect(telegram.notifyNewOrder).toHaveBeenCalledOnce();
        expect((await staff.get(o.id)).status).toBe('NEW');
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: f.user.id } })).phone,
        ).toBeNull();
      },
    );
    it('concurrent duplicate final confirmation creates exactly one order and notice', async () => {
      const f = await fixture(),
        s = await ready(f);
      const r = await Promise.allSettled([
        checkout.confirm(f.actor, s.id),
        checkout.confirm(f.actor, s.id),
      ]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      expect(telegram.notifyNewOrder).toHaveBeenCalledOnce();
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
    });
    it.each(['price', 'inactive', 'minimum', 'disabled'] as const)(
      'final %s revalidation rolls back session consumption and preserves cart',
      async (change) => {
        const f = await fixture(),
          s = await ready(f, change === 'minimum' ? 'DELIVERY' : 'PICKUP');
        if (change === 'price')
          await db.product.update({
            where: { id: f.product.id },
            data: { price: 99000 },
          });
        if (change === 'inactive')
          await db.product.update({
            where: { id: f.product.id },
            data: { active: false },
          });
        if (change === 'minimum')
          await db.shopSettings.update({
            where: { id: 1 },
            data: { minDeliverySubtotal: 999999 },
          });
        if (change === 'disabled')
          await db.shopSettings.update({
            where: { id: 1 },
            data: { pickupEnabled: false },
          });
        await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
        expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
        expect((await cart.get(f.user.id)).items).toHaveLength(1);
        expect((await session(f)).id).toBe(s.id);
        expect(telegram.notifyNewOrder).not.toHaveBeenCalled();
      },
    );
    it('product deletion and cart change cannot clear a newer cart or create a stale order', async () => {
      const f = await fixture(),
        s = await ready(f),
        c = await cart.get(f.user.id);
      await cart.change(f.user.id, c.revision, {
        kind: 'plus',
        productId: f.product.id,
      });
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
      expect((await cart.get(f.user.id)).items[0]!.qty).toBe(1000);
      await db.product.delete({ where: { id: f.product.id } });
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('concurrent checkout/cart mutation never clears a newer basket', async () => {
      const f = await fixture(),
        s = await ready(f),
        c = await cart.get(f.user.id);
      await Promise.allSettled([
        checkout.confirm(f.actor, s.id),
        cart.change(f.user.id, c.revision, {
          kind: 'plus',
          productId: f.product.id,
        }),
      ]);
      const count = await db.order.count({ where: { userId: f.user.id } });
      const current = await cart.get(f.user.id);
      if (count) expect(current.items).toHaveLength(0);
      else expect(current.items[0]!.qty).toBe(1000);
      expect(count).toBeLessThanOrEqual(1);
    });
    it('foreign identity cannot confirm another session', async () => {
      const f = await fixture(),
        other = await fixture(),
        s = await ready(f);
      await expect(checkout.confirm(other.actor, s.id)).rejects.toThrow();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('keeps a receiving preference across menu/cart navigation and creates no order', async () => {
      const f = await fixture(), handler = bot();
      await handler.handle(text(f.telegramId, '/delivery'));
      let state = await session(f);
      expect(state.action).toBe('CHECKOUT');
      await handler.handle(cb(f.telegramId, shoppingData('g', state.id, 'pickup')));
      state = await session(f);
      expect(receivingPayload.parse(state.payload).stage).toBe('DONE');
      await handler.handle(text(f.telegramId, '/menu'));
      await handler.handle(text(f.telegramId, '/cart'));
      expect((await session(f)).id).toBe(state.id);
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
      await add(f);
      await checkout.start(f.actor, (await cart.get(f.user.id)).revision);
      const checkoutState = await session(f);
      expect(checkoutState.action).toBe('CHECKOUT');
      expect(checkoutPayload.parse(checkoutState.payload).type).toBe('PICKUP');
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('saves an address through bound input exactly once without an order or cart change', async () => {
      const f = await fixture(), handler = bot();
      const before = await cart.get(f.user.id);
      await handler.handle(text(f.telegramId, '/delivery'));
      await handler.handle(cb(f.telegramId, shoppingData('g', (await session(f)).id, 'delivery')));
      await handler.handle(cb(f.telegramId, shoppingData('g', (await session(f)).id, 'new')));
      for (const input of ['Москва', 'Сохранённая', '5', '12', '-', '-', '-', 'Позвоните']) {
        const state = await session(f);
        expect(state.promptMessageId).not.toBeNull();
        await handler.handle(text(f.telegramId, input, state.promptMessageId!));
      }
      const review = await session(f);
      expect(receivingPayload.parse(review.payload).stage).toBe('REVIEW');
      expect(await db.address.count({ where: { userId: f.user.id } })).toBe(0);
      const action = { kind: 'receive' as const, revision: review.id, choice: 'save' as const };
      const attempts = await Promise.allSettled([checkout.chooseReceiving(f.actor, action), checkout.chooseReceiving(f.actor, action)]);
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await db.address.count({ where: { userId: f.user.id } })).toBe(1);
      expect(await db.address.findFirst({ where: { userId: f.user.id } })).toMatchObject({ city: 'Москва', street: 'Сохранённая', house: '5', isDefault: true });
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
      expect((await cart.get(f.user.id)).revision).toBe(before.revision);
    });
    it('rejects foreign addresses and stale edits against a concurrently changed saved address', async () => {
      const f = await fixture(), other = await fixture();
      const foreign = await db.address.create({ data: { userId: other.user.id, label: 'Чужой', city: 'Москва', street: 'Чужая', house: '1' } });
      let state = await checkout.receiving(f.actor);
      state = await checkout.chooseReceiving(f.actor, { kind: 'receive', revision: state.id, choice: 'delivery' });
      await expect(checkout.chooseReceiving(f.actor, { kind: 'receive', revision: state.id, choice: 'view', value: foreign.id })).rejects.toThrow();
      const own = await db.address.create({ data: { userId: f.user.id, label: 'Дом', city: 'Москва', street: 'Своя', house: '2', isDefault: true } });
      state = await checkout.chooseReceiving(f.actor, { kind: 'receive', revision: state.id, choice: 'view', value: own.id });
      await db.address.update({ where: { id: own.id }, data: { street: 'Изменено на сайте', updatedAt: new Date(own.updatedAt.getTime() + 1000) } });
      await expect(checkout.chooseReceiving(f.actor, { kind: 'receive', revision: state.id, choice: 'use' })).rejects.toThrow();
      expect((await db.address.findUniqueOrThrow({ where: { id: own.id } })).street).toBe('Изменено на сайте');
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('reuses only owned saved address and prefers own account contact over verified Telegram defaults', async () => {
      const f = await fixture();
      await db.user.update({
        where: { id: f.user.id },
        data: { phone: '+79990000004' },
      });
      await db.address.create({
        data: {
          userId: f.user.id,
          label: 'Дом',
          city: 'Москва',
          street: 'Своя',
          house: '2',
        },
      });
      const c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      expect(checkoutPayload.parse(s.payload).customerPhone).toBe(
        '+79990000004',
      );
      s = await checkout.choose(f.actor, s.id, 'delivery');
      expect(s.step).toBe('ADDRESS');
      s = await checkout.choose(f.actor, s.id, 'saved');
      expect(s.step).toBe('TIME');
      expect(checkoutPayload.parse(s.payload).address?.street).toBe('Своя');
    });

    it('chat unknown initial prompt survives restart and accepts only newly bound /resume reply once', async () => {
      const f = await fixture(),
        s = await ready(f),
        o = await checkout.confirm(f.actor, s.id);
      fetcher.mockRejectedValueOnce(new Error('unknown transport'));
      await bot().handle(cb(f.telegramId, customerView('w', o.publicId)));
      const pending = await session(f);
      expect(pending).toMatchObject({
        step: 'PROMPT',
        promptMessageId: null,
        action: 'CHAT',
      });
      await bot().handle(text(f.telegramId, 'arbitrary text', 999));
      expect(
        await db.orderChatMessage.count({
          where: { orderId: o.id, authorType: 'CUSTOMER' },
        }),
      ).toBe(0);
      await bot().handle(text(f.telegramId, '/resume'));
      const resumed = await session(f);
      expect(resumed.id).not.toBe(pending.id);
      expect(resumed.promptMessageId).not.toBeNull();
      await Promise.all(
        [1, 2].map(() =>
          bot().handle(text(f.telegramId, 'Message', resumed.promptMessageId!)),
        ),
      );
      expect(
        await db.orderChatMessage.count({
          where: { orderId: o.id, authorType: 'CUSTOMER' },
        }),
      ).toBe(1);
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: o.id } })).staffUnread,
      ).toBe(1);
    });
    it('chat resume invalidates the old bound prompt and /cancel invalidates all replies', async () => {
      const f = await fixture(),
        s = await ready(f),
        o = await checkout.confirm(f.actor, s.id);
      await bot().handle(cb(f.telegramId, customerView('w', o.publicId)));
      const old = await session(f);
      await bot().handle(text(f.telegramId, '/resume'));
      const next = await session(f);
      await bot().handle(text(f.telegramId, 'Old', old.promptMessageId!));
      expect((await session(f)).id).toBe(next.id);
      await bot().handle(text(f.telegramId, '/cancel'));
      await bot().handle(text(f.telegramId, 'Canceled', next.promptMessageId!));
      expect(
        await db.orderChatMessage.count({
          where: { orderId: o.id, authorType: 'CUSTOMER' },
        }),
      ).toBe(0);
    });
    it('delayed prompt cannot bind a canceled/replaced customer flow', async () => {
      const f = await fixture(),
        s = await ready(f),
        o = await checkout.confirm(f.actor, s.id);
      let release!: (r: Response) => void, start!: () => void;
      const started = new Promise<void>((r) => {
        start = r;
      });
      fetcher.mockImplementationOnce(() => {
        start();
        return new Promise<Response>((r) => {
          release = r;
        });
      });
      const opening = bot().handle(
        cb(f.telegramId, customerView('w', o.publicId)),
      );
      await started;
      // Simulate cancellation by a second process while delivery is in flight.
      await db.customerTelegramSession.deleteMany({ where: { identityId: f.identity.id } });
      release(Response.json({ ok: true, result: { message_id: 98765 } }));
      await opening;
      expect(
        await db.customerTelegramSession.findUnique({
          where: { identityId: f.identity.id },
        }),
      ).toBeNull();
    });
    it('checkout unknown prompt persists and /resume rotates its revision without accepting old replies', async () => {
      const f = await fixture(),
        c = await add(f);
      await bot().handle(cb(f.telegramId, shoppingData('b', c.revision)));
      let s = await session(f);
      fetcher.mockRejectedValueOnce(new Error('unknown prompt'));
      await bot().handle(cb(f.telegramId, shoppingData('f', s.id, 'pickup')));
      s = await session(f);
      expect(s).toMatchObject({ step: 'TIME', promptMessageId: null });
      await bot().handle(text(f.telegramId, '-', 987));
      expect((await session(f)).id).toBe(s.id);
      await bot().handle(text(f.telegramId, '/resume'));
      const next = await session(f);
      expect(next.id).not.toBe(s.id);
      expect(next.promptMessageId).not.toBeNull();
      await bot().handle(
        text(f.telegramId, '-', next.promptMessageId!),
      );
      expect((await session(f)).step).toBe('CONFIRM');
    });
    it('/menu cancels abandoned CHECKOUT input before displaying the inline home menu', async () => {
      const f = await fixture(), c = await add(f);
      await bot().handle(cb(f.telegramId, shoppingData('b', c.revision)));
      const type = await session(f);
      await bot().handle(cb(f.telegramId, shoppingData('f', type.id, 'pickup')));
      const pending = await session(f);
      expect(pending.step).toBe('TIME');
      expect(pending.promptMessageId).not.toBeNull();
      const prompt = sent().find(message => message.text?.includes('Нажмите «Ответить»'));
      expect(prompt?.reply_markup?.force_reply).toBe(true);
      expect(JSON.stringify(sent())).not.toContain('"keyboard"');
      expect(prompt?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
        .toEqual(['cancel', 'menu']);
      await bot().handle(text(f.telegramId, '/menu'));
      expect(await db.customerTelegramSession.findUnique({ where: { identityId: f.identity.id } })).toBeNull();
      const menu = sent().findLast(message => message.text?.startsWith('KorzinaMarket'));
      expect(menu?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
        .toEqual(expect.arrayContaining(['catalog', 'cart', 'orders', 'help']));
      await bot().handle(text(f.telegramId, '-', pending.promptMessageId!));
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
      expect(await db.customerTelegramSession.findUnique({ where: { identityId: f.identity.id } })).toBeNull();
    });
    it.each(['/catalog', '/cart', '/orders'])('%s supersedes abandoned CHECKOUT text input', async command => {
      const f = await fixture(), c = await add(f);
      await bot().handle(cb(f.telegramId, shoppingData('b', c.revision)));
      const type = await session(f);
      await bot().handle(cb(f.telegramId, shoppingData('f', type.id, 'pickup')));
      const pending = await session(f);
      await bot().handle(text(f.telegramId, command));
      expect(await db.customerTelegramSession.findUnique({ where: { identityId: f.identity.id } })).toBeNull();
      await bot().handle(text(f.telegramId, '-', pending.promptMessageId!));
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('completed CHECKOUT exposes menu and has no active text session', async () => {
      const f = await fixture(), s = await ready(f);
      await bot().handle(cb(f.telegramId, shoppingData('f', s.id, 'confirm')));
      expect(await db.customerTelegramSession.findUnique({ where: { identityId: f.identity.id } })).toBeNull();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      const receipt = sent().find(message => message.text?.includes('Заказ создан'));
      expect(receipt?.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data))
        .toContain('menu');
    });
    it('expired checkout/chat input cannot be consumed or resumed', async () => {
      const f = await fixture(),
        c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      await db.customerTelegramSession.update({
        where: { id: s.id },
        data: { expiresAt: new Date(0) },
      });
      await expect(checkout.choose(f.actor, s.id, 'pickup')).rejects.toThrow();
      expect(await checkout.resume(f.actor)).toBeNull();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('confirmation display failure cannot replay a committed order', async () => {
      const f = await fixture(),
        s = await ready(f);
      fetcher.mockRejectedValueOnce(new Error('lost display'));
      await bot().handle(cb(f.telegramId, shoppingData('f', s.id, 'confirm')));
      await bot().handle(cb(f.telegramId, shoppingData('f', s.id, 'confirm')));
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      expect(await checkout.resume(f.actor)).toBeNull();
    });
    it('resumed confirmation invalidates its old button and refreshes current prices', async () => {
      const f = await fixture(),
        s = await ready(f);
      await db.product.update({
        where: { id: f.product.id },
        data: { price: 40000 },
      });
      const next = await checkout.resume(f.actor);
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
      const order = await checkout.confirm(f.actor, next!.id);
      expect(order.subtotal).toBe(22000);
    });

    it('AWAITING displays configured requisites but callback/logs contain no payment data', async () => {
      const f = await fixture(),
        o = await paidReady(f);
      await bot().handle(
        cb(f.telegramId, shoppingData('p', o.publicId, 'SBP')),
      );
      const screen = sent().find((x) => x.text?.includes('К оплате за товары'));
      expect(screen?.text).toContain('test customer-visible requisite');
      const callbacks = screen?.reply_markup?.inline_keyboard
        ?.flat()
        .map((x) => x.callback_data ?? '')
        .join('');
      expect(callbacks).not.toContain('test customer-visible requisite');
      expect(
        JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls),
      ).not.toContain('test customer-visible requisite');
    });
    it('customer reports once, staff sees it and must verify before PAID/delivery', async () => {
      const f = await fixture(),
        o = await paidReady(f);
      const before = await db.order.findUniqueOrThrow({ where: { id: o.id } });
      const auditCount = await db.orderStaffAudit.count({
        where: { orderId: o.id },
      });
      await Promise.all(
        [1, 2].map(() =>
          bot().handle(cb(f.telegramId, shoppingData('r', o.publicId, 'SBP'))),
        ),
      );
      await bot().handle(
        cb(f.telegramId, shoppingData('r', o.publicId, 'SBP')),
      );
      expect(await db.orderStaffAudit.count({ where: { orderId: o.id } })).toBe(
        auditCount,
      );
      const p = await db.orderPayment.findUniqueOrThrow({
        where: { orderId: o.id },
      });
      expect(p).toMatchObject({
        status: 'REPORTED',
        method: 'SBP',
        confirmedById: null,
      });
      expect(telegram.notifyPaymentReported).toHaveBeenCalledOnce();
      expect(
        await db.orderChatMessage.count({
          where: {
            orderId: o.id,
            recipient: 'staff',
            text: { contains: 'Покупатель сообщил' },
          },
        }),
      ).toBe(1);
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: o.id } })).staffUnread,
      ).toBe(before.staffUnread + 1);
      expect(await db.delivery.count({ where: { orderId: o.id } })).toBe(0);
      await staff.confirmPayment(o.id, seller.userId, undefined, seller);
      expect(
        (await db.orderPayment.findUniqueOrThrow({ where: { orderId: o.id } }))
          .status,
      ).toBe('PAID');
      await orders.reportPayment(o.publicId, f.user.id, undefined, 'SBP');
      expect(
        (await db.orderPayment.findUniqueOrThrow({ where: { orderId: o.id } }))
          .status,
      ).toBe('PAID');
      expect(telegram.notifyPaymentReported).toHaveBeenCalledOnce();
    });
    it('wrong owner cannot report and USER cannot confirm payment', async () => {
      const f = await fixture(),
        o = await paidReady(f),
        other = await fixture();
      await expect(
        orders.reportPayment(o.publicId, other.user.id, undefined, 'SBP'),
      ).rejects.toThrow();
      await expect(
        staff.confirmPayment(o.id, f.user.id, undefined, {
          userId: f.user.id,
          role: 'SELLER',
        }),
      ).rejects.toThrow();
      expect(
        (await db.orderPayment.findUniqueOrThrow({ where: { orderId: o.id } }))
          .status,
      ).toBe('AWAITING');
    });
    it('unconfigured payment method rejected without side effects', async () => {
      const f = await fixture(),
        o = await paidReady(f);
      await expect(
        orders.reportPayment(o.publicId, f.user.id, undefined, 'CARD_TRANSFER'),
      ).rejects.toThrow();
      expect(
        (await db.orderPayment.findUniqueOrThrow({ where: { orderId: o.id } }))
          .status,
      ).toBe('AWAITING');
      expect(telegram.notifyPaymentReported).not.toHaveBeenCalled();
    });
    it('browse-only onboarding permits public catalog and help but protects cart and checkout until self-contact', async () => {
      const f = await fixture();
      await db.telegramIdentity.update({ where: { id: f.identity.id }, data: { phoneVerified: false, phoneNumber: null } });
      const initialCarts = await db.cart.count({ where: { userId: f.user.id } });
      await bot().handle(text(f.telegramId, '/menu'));
      await bot().handle(text(f.telegramId, '/catalog'));
      await bot().handle(text(f.telegramId, '/help'));
      await bot().handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
      await bot().handle(cb(f.telegramId, shoppingData('v', f.product.id, f.product.min)));
      const preview = sent().find(message => message.text?.includes('Для покупок подтвердите'));
      expect(preview?.text).toContain('500 г');
      expect(preview?.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data === 'verify_phone')).toBe(true);
      expect(preview?.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('s:a:'))).toBe(false);
      await bot().handle(cb(f.telegramId, shoppingData('a', randomUUID(), f.product.id, f.product.min, f.product.unit)));
      await bot().handle(text(f.telegramId, '/cart'));
      expect(await db.cart.count({ where: { userId: f.user.id } })).toBe(initialCarts);
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
      expect(await db.customerTelegramSession.findUnique({ where: { identityId: f.identity.id } })).toBeNull();
      expect((await db.telegramIdentity.findUniqueOrThrow({ where: { id: f.identity.id } })).phoneVerified).toBe(false);
    });
    it('clear requires an explicit current-revision confirmation and cannot affect an already created order', async () => {
      const f = await fixture(), draft = await ready(f);
      const order = await checkout.confirm(f.actor, draft.id);
      const beforeOrder = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
      const basket = await add(f);
      await bot().handle(cb(f.telegramId, shoppingData('z', basket.revision)));
      expect((await cart.get(f.user.id)).revision).toBe(basket.revision);
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
      expect(sent().some(message => message.text?.includes('Очистить корзину?'))).toBe(true);
      const changed = await cart.change(f.user.id, basket.revision, { kind: 'plus', productId: f.product.id });
      await bot().handle(cb(f.telegramId, shoppingData('y', basket.revision)));
      expect((await cart.get(f.user.id)).revision).toBe(changed.revision);
      await bot().handle(cb(f.telegramId, shoppingData('z', changed.revision)));
      await Promise.all([1, 2].map(() => bot().handle(cb(f.telegramId, shoppingData('y', changed.revision)))));
      expect((await cart.get(f.user.id)).items).toHaveLength(0);
      expect(await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })).toEqual(beforeOrder);
    });
    it('all customer commands retain private-chat and actor equality enforcement', async () => {
      const f = await fixture();
      await add(f);
      for (const command of [
        '/start',
        '/menu',
        '/catalog',
        '/cart',
        '/orders',
        '/current',
        '/messages',
        '/resume',
        '/cancel',
        '/help',
      ])
        await bot().handle(text(f.telegramId, command));
      expect(sent().some((x) => x.text?.includes('Каталог'))).toBe(true);
      const count = fetcher.mock.calls.length;
      for (const type of ['group', 'supergroup', 'channel'])
        await bot().handle({
          message: {
            ...text(f.telegramId, '/cart').message,
            chat: { id: f.telegramId, type },
          },
        });
      await bot().handle({
        message: {
          ...text(f.telegramId, '/cart').message,
          chat: { id: f.telegramId + 1, type: 'private' },
        },
      });
      expect(fetcher.mock.calls).toHaveLength(count);
    });
    it('catalog excludes hidden categories/products and quantity buttons follow current min/step', async () => {
      const f = await fixture();
      await bot().handle(
        cb(f.telegramId, shoppingData('v', f.product.id, f.product.min)),
      );
      const screen = sent().find((x) => x.text?.includes('В корзине:'));
      expect(screen?.text).toContain('500 г');
      const details = screen?.reply_markup?.inline_keyboard?.flat().find(button => button.text === '📷 Фото и описание');
      expect(shoppingAction(details?.callback_data ?? '')).toMatchObject({ kind: 'details', productId: f.product.id });
      expect(
        screen?.reply_markup?.inline_keyboard
          ?.flat()
          .some(
            (b) => {
              const action = shoppingAction(b.callback_data ?? '');
              return action?.kind === 'adjust' && action.productId === f.product.id && action.delta === 500;
            },
          ),
      ).toBe(true);
      await db.category.update({
        where: { id: f.category.id },
        data: { active: false },
      });
      await bot().handle(cb(f.telegramId, shoppingData('l', f.category.id, 0)));
      expect(sent().at(-1)?.text).toContain('Товар или заказ недоступен');
    });
    it('failed database insert rolls back consumed checkout and cart, without a staff notification', async () => {
      const f = await fixture(),
        s = await ready(f);
      await db.customerTelegramSession.update({
        where: { id: s.id },
        data: {
          payload: {
            ...checkoutPayload.parse(s.payload),
            customerName: 'reject-checkout-fixture',
          },
        },
      });
      await connection.query(`CREATE FUNCTION reject_checkout_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."customerName" = 'reject-checkout-fixture' THEN RAISE EXCEPTION 'TEST_ROLLBACK'; END IF; RETURN NEW; END $$`);
      await connection.query(
        'CREATE TRIGGER reject_checkout_fixture BEFORE INSERT ON "Order" FOR EACH ROW EXECUTE FUNCTION reject_checkout_fixture()',
      );
      try {
        await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
        expect((await session(f)).id).toBe(s.id);
        expect((await cart.get(f.user.id)).items).toHaveLength(1);
        expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
        expect(telegram.notifyNewOrder).not.toHaveBeenCalled();
      } finally {
        await connection.query(
          'DROP TRIGGER reject_checkout_fixture ON "Order"',
        );
        await connection.query('DROP FUNCTION reject_checkout_fixture()');
      }
    });
    it('a negative add cannot reduce an existing line through the reusable cart domain', async () => {
      const f = await fixture(),
        c = await add(f, 1000);
      await expect(
        cart.change(f.user.id, c.revision, {
          kind: 'add',
          productId: f.product.id,
          qty: -500,
        }),
      ).rejects.toThrow();
      expect((await cart.get(f.user.id)).items[0]!.qty).toBe(1000);
    });
    it('checkout later prompt UNKNOWN retains payload and duplicate replies advance once', async () => {
      const f = await fixture(), c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      s = await checkout.choose(f.actor, s.id, 'delivery');
      s = await checkout.choose(f.actor, s.id, 'new');
      expect(s.step).toBe('CITY');
      s = await bind(f);
      fetcher.mockRejectedValueOnce(new Error('lost next prompt'));
      await bot().handle(text(f.telegramId, 'Москва', s.promptMessageId!));
      const waiting = await session(f);
      expect(waiting).toMatchObject({ step: 'STREET', promptMessageId: null });
      expect(checkoutPayload.parse(waiting.payload)).toMatchObject({ customerPhone: f.identity.phoneNumber, address: { city: 'Москва' } });
      await bot().handle(text(f.telegramId, '/resume'));
      const resumed = await session(f);
      const replies = await Promise.allSettled([
        checkout.reply(f.actor, 'Тестовая улица', resumed.promptMessageId!),
        checkout.reply(f.actor, 'Тестовая улица', resumed.promptMessageId!),
      ]);
      expect(replies.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await session(f)).step).toBe('HOUSE');
      expect(checkoutPayload.parse((await session(f)).payload).address?.street).toBe('Тестовая улица');
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('simultaneous resumes with delayed responses leave only the newest exact checkout prompt active', async () => {
      const f = await fixture(),
        c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      s = await checkout.choose(f.actor, s.id, 'pickup');
      let release!: (r: Response) => void, start!: () => void;
      const started = new Promise<void>((r) => {
        start = r;
      });
      fetcher.mockImplementationOnce(() => {
        start();
        return new Promise<Response>((r) => {
          release = r;
        });
      });
      const first = bot().handle(text(f.telegramId, '/resume'));
      await started;
      const second = bot().handle(text(f.telegramId, '/resume'));
      release(Response.json({ ok: true, result: { message_id: 76543 } }));
      await Promise.all([first, second]);
      expect((await session(f)).promptMessageId).not.toBe(76543);
      await expect(
        checkout.reply(f.actor, '-', 76543),
      ).rejects.toThrow();
      expect((await session(f)).step).toBe('TIME');
    });
    it('checkout reservation already exists when its initial presentation fails', async () => {
      const f = await fixture(),
        c = await add(f);
      fetcher.mockRejectedValueOnce(new Error('initial screen unknown'));
      await bot().handle(cb(f.telegramId, shoppingData('b', c.revision)));
      expect(await session(f)).toMatchObject({
        action: 'CHECKOUT',
        step: 'TYPE',
        promptMessageId: null,
      });
      await bot().handle(text(f.telegramId, '/resume'));
      expect(sent().some((m) => m.text === 'Как получить заказ?')).toBe(true);
    });
    it('forged saved-address reference is still ownership-bound at selection', async () => {
      const f = await fixture(),
        other = await fixture();
      const address = await db.address.create({
        data: {
          userId: other.user.id,
          label: 'Other',
          city: 'Москва',
          street: 'Other',
          house: '1',
        },
      });
      const c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      await db.customerTelegramSession.update({
        where: { id: s.id },
        data: {
          step: 'ADDRESS',
          payload: {
            ...checkoutPayload.parse(s.payload),
            type: 'DELIVERY',
            addressId: address.id,
          },
        },
      });
      await expect(checkout.choose(f.actor, s.id, 'saved')).rejects.toThrow();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it('cart/customer-session FKs cascade without deleting product or order history', async () => {
      const f = await fixture(),
        c = await add(f);
      await checkout.start(f.actor, c.revision);
      await db.telegramIdentity.delete({ where: { id: f.identity.id } });
      expect(
        await db.customerTelegramSession.findUnique({
          where: { identityId: f.identity.id },
        }),
      ).toBeNull();
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
      await db.user.delete({ where: { id: f.user.id } });
      expect(await db.cart.count({ where: { userId: f.user.id } })).toBe(0);
      expect(
        await db.cartItem.count({ where: { productId: f.product.id } }),
      ).toBe(0);
      expect(
        await db.product.findUnique({ where: { id: f.product.id } }),
      ).not.toBeNull();
    });
    it('catalog/cart messages stay bounded for fifty lines and all emitted callbacks fit 64 bytes', async () => {
      const f = await fixture(),
        c = await add(f);
      const stored = await db.cart.findUniqueOrThrow({
        where: { userId: f.user.id },
      });
      for (let i = 0; i < 49; i++) {
        const p = await db.product.create({
          data: {
            ...f.product,
            normalizedPrice: undefined,
            id: undefined,
            slug: randomUUID(),
            name: 'Длинное название '.repeat(30),
          },
        });
        await db.cartItem.create({
          data: { cartId: stored.id, productId: p.id, qty: 500 },
        });
      }
      await bot().handle(text(f.telegramId, '/cart'));
      for (const m of sent()) {
        if (m.text) expect(m.text.length).toBeLessThanOrEqual(4096);
        for (const b of m.reply_markup?.inline_keyboard?.flat() ?? [])
          if (b.callback_data)
            expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      }
      await expect(
        cart.change(f.user.id, c.revision, {
          kind: 'add',
          productId: (await fixture()).product.id,
          qty: 500,
        }),
      ).rejects.toThrow();
    });

    it('stale remove cannot delete a re-added product and page reads keep revision stable', async () => {
      const f = await fixture(),
        first = await add(f);
      await cart.change(f.user.id, first.revision, {
        kind: 'remove',
        productId: f.product.id,
      });
      const next = await add(f);
      await bot().handle(text(f.telegramId, '/cart'));
      await bot().handle(cb(f.telegramId, shoppingData('k', 0)));
      expect((await cart.get(f.user.id)).revision).toBe(next.revision);
      await expect(
        cart.change(f.user.id, first.revision, {
          kind: 'remove',
          productId: f.product.id,
        }),
      ).rejects.toThrow();
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
    });
    it('simultaneous plus/minus consume one cart revision, never both', async () => {
      const f = await fixture(),
        c = await add(f, 1000);
      const results = await Promise.allSettled(
        (['plus', 'minus'] as const).map((kind) =>
          cart.change(f.user.id, c.revision, { kind, productId: f.product.id }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect([500, 1500]).toContain((await cart.get(f.user.id)).items[0]!.qty);
    });
    it('holds the cart lock through Order INSERT and commit before allowing newer cart writes', async () => {
      const f = await fixture(),
        s = await ready(f),
        c = await cart.get(f.user.id);
      let inserted!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => {
        inserted = r;
      });
      const hold = new Promise<void>((r) => {
        release = r;
      });
      const createIn = orders.createIn.bind(orders);
      vi.spyOn(orders, 'createIn').mockImplementationOnce(async (...args) => {
        const result = await createIn(...args);
        inserted();
        await hold;
        return result;
      });
      const creating = checkout.confirm(f.actor, s.id);
      let changing:
        | Promise<
            PromiseSettledResult<Awaited<ReturnType<CartService['change']>>>[]
          >
        | undefined;
      try {
        await reached;
        expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
        expect(telegram.notifyNewOrder).not.toHaveBeenCalled();
        changing = Promise.allSettled([
          cart.change(f.user.id, c.revision, {
            kind: 'plus',
            productId: f.product.id,
          }),
        ]);
        await vi.waitFor(
          async () => {
            const waiting = await connection.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = $2 AND query = $3',
              [
                schema,
                'Lock',
                'SELECT id FROM "User" WHERE id = $1 FOR UPDATE',
              ],
            );
            expect(waiting.rows[0]!.n).toBeGreaterThan(0);
          },
          { timeout: 2000, interval: 10 },
        );
      } finally {
        release();
        await Promise.allSettled([creating, ...(changing ? [changing] : [])]);
      }
      await creating;
      expect((await changing!)[0]!.status).toBe('rejected');
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      expect((await cart.get(f.user.id)).items).toHaveLength(0);
      expect(telegram.notifyNewOrder).toHaveBeenCalledOnce();
      const newer = await add(f);
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow();
      expect((await cart.get(f.user.id)).revision).toBe(newer.revision);
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
    });
    it('failure AFTER Order INSERT rolls back the order, snapshots, cart and session claim', async () => {
      const f = await fixture(),
        s = await ready(f),
        c = await cart.get(f.user.id);
      const createIn = orders.createIn.bind(orders);
      vi.spyOn(orders, 'createIn').mockImplementationOnce(async (...args) => {
        await createIn(...args);
        throw new Error('TEST_AFTER_ORDER_INSERT');
      });
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow(
        'TEST_AFTER_ORDER_INSERT',
      );
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(0);
      expect(
        await db.orderItem.count({ where: { productId: f.product.id } }),
      ).toBe(0);
      expect((await cart.get(f.user.id)).revision).toBe(c.revision);
      expect((await session(f)).id).toBe(s.id);
      expect(telegram.notifyNewOrder).not.toHaveBeenCalled();
      await checkout.confirm(f.actor, s.id);
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
    });
    it('restart after commit but before notification/response cannot recreate the order', async () => {
      const f = await fixture(),
        s = await ready(f);
      const postCommit = vi
        .spyOn(orders, 'created')
        .mockImplementationOnce(() => {
          throw new Error('TEST_INTERRUPTED_AFTER_COMMIT');
        });
      await expect(checkout.confirm(f.actor, s.id)).rejects.toThrow(
        'TEST_INTERRUPTED_AFTER_COMMIT',
      );
      postCommit.mockRestore();
      const restarted = new CustomerCheckoutService(
        db as unknown as DbService,
        cart,
        orders,
      );
      await expect(restarted.confirm(f.actor, s.id)).rejects.toThrow();
      expect(await restarted.resume(f.actor)).toBeNull();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      expect((await cart.get(f.user.id)).items).toHaveLength(0);
      expect(telegram.notifyNewOrder).not.toHaveBeenCalled();
    });
    it('website create retains one committed normal order and one staff notification', async () => {
      const f = await fixture();
      const result = await orders.create(f.user.id, undefined, {
        type: 'PICKUP',
        customerName: 'Website',
        customerPhone: '+79990000005',
        items: [{ productId: f.product.id, qty: 500 }],
      });
      expect(
        await db.order.count({
          where: { id: result.order.id, userId: f.user.id },
        }),
      ).toBe(1);
      expect(telegram.notifyNewOrder).toHaveBeenCalledExactlyOnceWith(
        result.order.id,
      );
    });
    it('staff provider UNKNOWN cannot roll back payment or duplicate its durable attention signal', async () => {
      const f = await fixture(),
        o = await paidReady(f);
      vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
      vi.stubEnv('TELEGRAM_STAFF_WEBHOOK_SECRET', randomUUID());
      vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', '123');
      fetcher.mockRejectedValue(
        new Error('TEST_PROVIDER_DETAILS_MUST_NOT_LEAK'),
      );
      const typed = db as unknown as DbService;
      const service = new OrderService(typed, new TelegramService(typed));
      await service.reportPayment(o.publicId, f.user.id, undefined, 'SBP');
      await vi.waitFor(() =>
        expect(vi.mocked(Logger.prototype.warn)).toHaveBeenCalledWith(
          'Telegram staff payment notice failed',
        ),
      );
      await service.reportPayment(o.publicId, f.user.id, undefined, 'SBP');
      expect(fetcher).toHaveBeenCalledOnce();
      expect(
        (await db.orderPayment.findUniqueOrThrow({ where: { orderId: o.id } }))
          .status,
      ).toBe('REPORTED');
      expect(
        await db.orderChatMessage.count({
          where: { orderId: o.id, recipient: 'staff' },
        }),
      ).toBe(1);
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: o.id } })).staffUnread,
      ).toBe(1);
      expect(
        JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls),
      ).not.toContain('TEST_PROVIDER_DETAILS_MUST_NOT_LEAK');
    });
    it.each(['order-canceled', 'payment-canceled', 'amount-changed'] as const)(
      'rejects payment reporting after %s without chat/audit/notice side effects',
      async (kind) => {
        const f = await fixture(),
          o = await paidReady(f);
        if (kind === 'order-canceled')
          await staff.cancel(
            o.id,
            seller.userId,
            seller.role,
            'Fixture',
            seller,
          );
        else
          await db.orderPayment.update({
            where: { orderId: o.id },
            data:
              kind === 'payment-canceled'
                ? { status: 'CANCELED' }
                : { amount: 1 },
          });
        const messages = await db.orderChatMessage.count({
          where: { orderId: o.id },
        });
        const audits = await db.orderStaffAudit.count({
          where: { orderId: o.id },
        });
        await expect(
          orders.reportPayment(o.publicId, f.user.id, undefined, 'SBP'),
        ).rejects.toThrow();
        expect(
          await db.orderChatMessage.count({ where: { orderId: o.id } }),
        ).toBe(messages);
        expect(
          await db.orderStaffAudit.count({ where: { orderId: o.id } }),
        ).toBe(audits);
        expect(telegram.notifyPaymentReported).not.toHaveBeenCalled();
      },
    );
    it('switching a DELIVERY confirmation to PICKUP cannot persist old address fields', async () => {
      const f = await fixture();
      let s = await ready(f, 'DELIVERY');
      s = await checkout.choose(f.actor, s.id, 'edit');
      s = await checkout.choose(f.actor, s.id, 'pickup');
      expect(s.step).toBe('CONFIRM');
      s = await checkout.choose(f.actor, s.id, 'edit_name');
      s = await bind(f);
      s = await checkout.reply(f.actor, 'Pickup customer', s.promptMessageId!);
      s = await checkout.choose(f.actor, s.id, 'edit_phone');
      s = await bind(f);
      s = await checkout.reply(f.actor, '+79990000002', s.promptMessageId!);
      const o = await checkout.confirm(f.actor, s.id);
      const row = await db.order.findUniqueOrThrow({ where: { id: o.id } });
      for (const field of [
        'city',
        'street',
        'house',
        'flat',
        'entrance',
        'floor',
        'intercom',
        'comment',
      ] as const)
        expect(row[field]).toBeNull();
      expect(row.type).toBe('PICKUP');
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: f.user.id } })).phone,
      ).toBeNull();
    });
    it('CHAT and CHECKOUT deliberately replace one another without reviving delayed prompts', async () => {
      const f = await fixture(),
        s = await ready(f),
        o = await checkout.confirm(f.actor, s.id);
      let release!: (r: Response) => void, delivered!: () => void;
      const pending = new Promise<void>((r) => {
        delivered = r;
      });
      fetcher.mockImplementationOnce(() => {
        delivered();
        return new Promise<Response>((r) => {
          release = r;
        });
      });
      const opening = bot().handle(
        cb(f.telegramId, customerView('w', o.publicId)),
      );
      await pending;
      const c = await add(f);
      const current = await checkout.start(f.actor, c.revision);
      release(Response.json({ ok: true, result: { message_id: 87878 } }));
      await opening;
      expect((await session(f)).id).toBe(current.id);
      expect((await session(f)).promptMessageId).toBeNull();
      await bot().handle(text(f.telegramId, 'Old chat input', 87878));
      expect(
        await db.orderChatMessage.count({
          where: { orderId: o.id, authorType: 'CUSTOMER' },
        }),
      ).toBe(0);
      await bot().handle(cb(f.telegramId, customerView('w', o.publicId)));
      expect((await session(f)).action).toBe('CHAT');
      await expect(
        checkout.choose(f.actor, current.id, 'pickup'),
      ).rejects.toThrow();
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
    });
    it('SQL rejects impossible session shapes and domain rejects an invalid object draft', async () => {
      const f = await fixture(),
        s = await ready(f),
        o = await checkout.confirm(f.actor, s.id);
      const c = await add(f),
        draft = await checkout.start(f.actor, c.revision);
      const cases: [string, string, number | null, unknown, number | null][] = [
        ['CHAT', 'PROMPT', null, null, null],
        ['CHAT', 'TEXT', o.id, null, null],
        ['CHAT', 'PROMPT', o.id, null, 1],
        ['CHAT', 'PROMPT', o.id, {}, null],
        ['CHAT', 'TYPE', o.id, null, null],
        ['CHECKOUT', 'TYPE', o.id, {}, null],
        ['CHECKOUT', 'TYPE', null, null, null],
        ['CHECKOUT', 'TYPE', null, 'scalar', null],
        ['CHECKOUT', 'BUSY', null, {}, null],
        ['CHECKOUT', 'CONFIRM', null, {}, 1],
        ['CHECKOUT', 'PHONE', null, {}, -1],
        ['UNKNOWN', 'TYPE', null, {}, null],
      ];
      for (const [action, step, orderId, payload, prompt] of cases) {
        await expect(
          connection.query(
            'UPDATE "CustomerTelegramSession" SET action=$1,step=$2,"orderId"=$3,payload=$4::jsonb,"promptMessageId"=$5 WHERE id=$6',
            [
              action,
              step,
              orderId,
              payload === null ? null : JSON.stringify(payload),
              prompt,
              draft.id,
            ],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      expect((await session(f)).id).toBe(draft.id);
      await db.customerTelegramSession.update({
        where: { id: draft.id },
        data: { step: 'CONFIRM', payload: { type: 'PICKUP' } },
      });
      await expect(checkout.confirm(f.actor, draft.id)).rejects.toThrow();
      expect(await db.order.count({ where: { userId: f.user.id } })).toBe(1);
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
    });

    it('migration preserves an existing bound CHAT session and adds nullable payload without rewriting orders', async () => {
      const rows = await db.customerTelegramSession.findMany({
        where: { order: { customerName: 'migration-fixture' } },
        include: { order: true, identity: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.step).sort()).toEqual(['PROMPT', 'TEXT']);
      for (const row of rows) {
        expect(row).toMatchObject({ action: 'CHAT', payload: null });
        expect(row.order!.userId).toBe(row.identity.userId);
        expect(row.promptMessageId).toBe(row.step === 'TEXT' ? 901 : null);
      }
    });
    it('stale checkout cancel cannot remove a resumed/newer session', async () => {
      const f = await fixture(),
        c = await add(f);
      const s = await checkout.start(f.actor, c.revision),
        next = await checkout.resume(f.actor);
      await expect(checkout.cancel(f.actor, s.id)).rejects.toThrow();
      expect((await session(f)).id).toBe(next!.id);
      await checkout.cancel(f.actor, next!.id);
      expect(
        await db.customerTelegramSession.findUnique({
          where: { identityId: f.identity.id },
        }),
      ).toBeNull();
      expect((await cart.get(f.user.id)).items).toHaveLength(1);
    });
    it('expired guest access is resolved before payment acquires an order lock', async () => {
      const f = await fixture();
      const created = await orders.create(null, undefined, {
        type: 'PICKUP',
        customerName: 'Guest',
        customerPhone: '+79990000005',
        items: [{ productId: f.product.id, qty: 500 }],
      });
      const saved = await db.order.findUniqueOrThrow({
        where: { id: created.order.id },
      });
      await db.guestSession.update({
        where: { id: saved.guestSessionId! },
        data: { expiresAt: new Date(0) },
      });
      await expect(
        orders.reportPayment(
          created.order.publicId,
          null,
          created.guestToken,
          'SBP',
        ),
      ).rejects.toThrow();
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: created.order.id } }))
          .guestSessionId,
      ).toBeNull();
    });
  },
);
