import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Unit } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { CartService } from '../src/cart/cart.service.js';
import { OrderService } from '../src/order/order.service.js';
import { CoordinationService } from '../src/order/coordination.service.js';
import { NotificationService } from '../src/order/notification.service.js';
import { StaffService } from '../src/staff/staff.service.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import { CustomerCheckoutService } from '../src/telegram/customer-checkout.service.js';
import { CustomerShopService } from '../src/telegram/customer-shop.service.js';
import { CustomerUpdateService } from '../src/telegram/customer-update.service.js';
import { checkoutPayload } from '../src/telegram/checkout.js';
import { shoppingData } from '../src/telegram/shopping-callback.js';
import { customerView } from '../src/telegram/customer-callback.js';

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
    } as unknown as NotificationService;
    const telegram = {
      notifyNewOrder: vi.fn().mockResolvedValue(undefined),
      notifyPaymentReported: vi.fn().mockResolvedValue(undefined),
    };
    const fetcher = vi.fn<typeof fetch>();
    let messageId = 100;
    type Sent = {
      text?: string;
      reply_markup?: {
        force_reply?: boolean;
        inline_keyboard?: {
          text: string;
          callback_data?: string;
          url?: string;
        }[][];
      };
    };
    const sent = () =>
      fetcher.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)) as Sent,
      );
    const bot = () => {
      const typed = db as unknown as DbService;
      const flow = new CustomerCheckoutService(typed, cart, orders);
      return new CustomerUpdateService(
        typed,
        coordination,
        orders,
        new CustomerShopService(typed, cart, flow, orders),
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
      coordination = new CoordinationService(typed, orders, notices);
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
      expect(s.step).toBe('PHONE'); // Telegram metadata phone never silently becomes an order contact.
      s = await bind(f);
      s = await checkout.reply(f.actor, '+79990000002', s.promptMessageId!);
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
      expect((await cart.get(f.user.id)).subtotal).toBe(35000);
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
        const f = await fixture(),
          s = await ready(f, type);
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
          subtotal: 17500,
        });
        expect(saved.items[0]).toMatchObject({
          price: 35000,
          priceQty: 1000,
          unit: 'GRAM',
          qty: 500,
          total: 17500,
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
    it('reuses only owned saved address and account contact; no Telegram phone auto-fill', async () => {
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
      await bot().handle(text(f.telegramId, '/cancel'));
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
      expect(s).toMatchObject({ step: 'PHONE', promptMessageId: null });
      await bot().handle(text(f.telegramId, '+79990000002', 987));
      expect((await session(f)).id).toBe(s.id);
      await bot().handle(text(f.telegramId, '/resume'));
      const next = await session(f);
      expect(next.id).not.toBe(s.id);
      expect(next.promptMessageId).not.toBeNull();
      await bot().handle(
        text(f.telegramId, '+79990000002', next.promptMessageId!),
      );
      expect((await session(f)).step).toBe('TIME');
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
      expect(order.subtotal).toBe(20000);
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
      const screen = sent().find((x) => x.text?.includes('Выбрано:'));
      expect(screen?.text).toContain('500 г');
      expect(
        screen?.reply_markup?.inline_keyboard
          ?.flat()
          .some(
            (b) => b.callback_data === shoppingData('v', f.product.id, 1000),
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
      const f = await fixture(),
        c = await add(f);
      let s = await checkout.start(f.actor, c.revision);
      s = await checkout.choose(f.actor, s.id, 'pickup');
      s = await bind(f);
      fetcher.mockRejectedValueOnce(new Error('lost next prompt'));
      await bot().handle(
        text(f.telegramId, '+79990000002', s.promptMessageId!),
      );
      const waiting = await session(f);
      expect(waiting).toMatchObject({ step: 'TIME', promptMessageId: null });
      expect(checkoutPayload.parse(waiting.payload).customerPhone).toBe(
        '+79990000002',
      );
      await bot().handle(text(f.telegramId, '/resume'));
      const resumed = await session(f);
      const replies = await Promise.allSettled([
        checkout.reply(f.actor, '-', resumed.promptMessageId!),
        checkout.reply(f.actor, '-', resumed.promptMessageId!),
      ]);
      expect(replies.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await session(f)).step).toBe('CONFIRM');
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
      await bot().handle(text(f.telegramId, '/resume'));
      const current = await session(f);
      release(Response.json({ ok: true, result: { message_id: 76543 } }));
      await first;
      expect(await session(f)).toEqual(current);
      await expect(
        checkout.reply(f.actor, '+79990000002', 76543),
      ).rejects.toThrow();
      expect((await session(f)).step).toBe('PHONE');
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
      for (const value of ['Pickup customer', '+79990000002', '-']) {
        s = await bind(f);
        s = await checkout.reply(f.actor, value, s.promptMessageId!);
      }
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
