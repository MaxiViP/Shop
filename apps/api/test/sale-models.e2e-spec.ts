import { ResearchDraftsService } from '../src/admin/research-drafts.service.js';
import { ProductService } from '../src/product/product.service.js';
import { productQuerySchema } from '../src/product/schema.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import type { DbService } from '../src/db/db.service.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import type { NotificationService } from '../src/order/notification.service.js';
import { OrderService } from '../src/order/order.service.js';
import { StaffService } from '../src/staff/staff.service.js';
import { CoordinationService } from '../src/order/coordination.service.js';
import { CartService } from '../src/cart/cart.service.js';
import { applyPlan, type SalePlan } from '../data/sale-audit/apply.js';

describe.skipIf(!process.env.DATABASE_URL)(
  'sale models / isolated local database',
  () => {
    const schema = `sale_test_${randomUUID().replaceAll('-', '')}`;
    let connection: pg.Client;
    let db: PrismaClient;
    let orders: OrderService;
    let staff: StaffService;
    let coordination: CoordinationService;
    let cart: CartService;
    let wholeId: number;
    let looseId: number;
    let sellerId: number;
    let customerId: number;
    beforeAll(async () => {
      const connectionString = process.env.DATABASE_URL!;
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(connectionString).hostname,
        )
      )
        throw new Error('Local DB required');
      connection = new pg.Client({ connectionString });
      await connection.connect();
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET search_path TO "${schema}"`);
      const dir = new URL('../prisma/migrations/', import.meta.url);
      for (const entry of (await readdir(dir, { withFileTypes: true }))
        .filter((value) => value.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(
          await readFile(new URL(`${entry.name}/migration.sql`, dir), 'utf8'),
        );
      db = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString, options: `-c search_path=${schema}` },
          { schema },
        ),
      });
      const database = db as unknown as DbService;
      const notifications = {
        dispatch: async () => {},
        dispatchTelegram: async () => {},
        dispatchStaffPrice: async () => {},
      } as unknown as NotificationService;
      orders = new OrderService(database, {
        notifyNewOrder: async () => {},
      } as unknown as TelegramService);
      staff = new StaffService(database, notifications);
      coordination = new CoordinationService(
        database,
        orders,
        notifications,
        undefined!,
      );
      cart = new CartService(database, orders);
      const category = await db.category.create({
        data: { name: 'Рыба и мясо', slug: 'sale-fixtures' },
      });
      wholeId = (
        await db.product.create({
          data: {
            name: 'Целая дорадо',
            slug: 'whole-fish',
            categoryId: category.id,
            price: 150000,
            unit: 'PIECE',
            priceUnit: 'GRAM',
            saleModel: 'WHOLE_VARIABLE_WEIGHT',
            wholeLabel: 'рыба',
            priceQty: 1000,
            min: 1,
            step: 1,
            portionQty: 1,
          },
        })
      ).id;
      looseId = (
        await db.product.create({
          data: {
            name: 'Старые томаты',
            slug: 'loose',
            categoryId: category.id,
            price: 10000,
            unit: 'GRAM',
            priceQty: 1000,
            min: 300,
            step: 100,
            portionQty: 500,
          },
        })
      ).id;
      sellerId = (await db.user.create({ data: { role: 'SELLER' } })).id;
      customerId = (await db.user.create({ data: {} })).id;
    }, 60000);
    afterAll(async () => {
      await db?.$disconnect();
      if (connection && /^sale_test_[a-f0-9]{32}$/.test(schema))
        await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
      await connection?.end();
    });
    const buyer = {
      type: 'PICKUP' as const,
      customerName: 'Покупатель',
      customerPhone: '+79990000000',
    };
    async function assemble(qty: number, weightMinGrams?: number) {
      const result = await orders.create(null, undefined, {
        ...buyer,
        items: [
          { productId: wholeId, qty, quantityUnit: 'PIECE', weightMinGrams },
        ],
      });
      await db.order.update({
        where: { id: result.order.id },
        data: { status: 'ASSEMBLING' },
      });
      return result;
    }
    const actor = () => ({ userId: sellerId, role: 'SELLER' as const });
    it('quotes unknown whole weight, preserves mixed known costs and rejects stale gram counts', async () => {
      const quote = await orders.quote({
        items: [
          { productId: wholeId, qty: 1, quantityUnit: 'PIECE' },
          { productId: looseId, qty: 500 },
        ],
      });
      expect(quote).toMatchObject({
        valid: true,
        subtotal: null,
        knownSubtotal: 5500,
        pendingWeight: true,
      });
      expect(quote.token).toMatch(/^[a-f0-9]{64}$/);
      for (const qty of [-1, 0, 1.1, 101])
        expect(
          (
            await orders.quote({
              items: [{ productId: wholeId, qty, quantityUnit: 'PIECE' }],
            })
          ).valid,
        ).toBe(false);
      expect(
        (
          await orders.quote({
            items: [{ productId: wholeId, qty: 1, quantityUnit: 'GRAM' }],
          })
        ).valid,
      ).toBe(false);
    });
    it('persists guest checkout, specimen count and final actual grams without false tolerance issues', async () => {
      const result = await assemble(1);
      expect(result.order.subtotal).toBeNull();
      expect(result.order.items[0]!.total).toBeNull();
      expect(
        (await orders.get(result.order.publicId, null, result.guestToken))
          .items[0],
      ).toMatchObject({
        qty: 1,
        saleModel: 'WHOLE_VARIABLE_WEIGHT',
        unit: 'PIECE',
        priceUnit: 'GRAM',
      });
      await expect(orders.get(result.order.publicId, null)).rejects.toThrow();
      const item = result.order.items[0]!;
      await staff.item(
        result.order.id,
        item.id,
        { status: 'PICKED', actualQty: 1, pieceWeights: [1780] },
        sellerId,
        actor(),
      );
      expect(
        await db.orderIssue.count({ where: { orderId: result.order.id } }),
      ).toBe(0);
      await staff.finishAssembly(result.order.id, actor());
      expect(
        await db.order.findUnique({ where: { id: result.order.id } }),
      ).toMatchObject({
        finalSubtotal: 293700,
        finalTotal: 293700,
        status: 'READY',
      });
      expect(
        await db.orderItem.findUnique({ where: { id: item.id } }),
      ).toMatchObject({
        qty: 1,
        actualQty: 1,
        actualWeightGrams: 1780,
        pieceWeights: [1780],
      });
    });
    it('requires the exact weighing approval when any individual specimen violates buyer limits', async () => {
      const result = await assemble(2, 1400);
      const item = result.order.items[0]!;
      await staff.item(
        result.order.id,
        item.id,
        { status: 'PICKED', actualQty: 2, pieceWeights: [1250, 1750] },
        sellerId,
        actor(),
      );
      await expect(
        staff.finishAssembly(result.order.id, actor()),
      ).rejects.toThrow();
      const issue = await db.orderIssue.findUniqueOrThrow({
        where: { orderItemId: item.id },
      });
      await coordination.decide(
        {
          publicId: result.order.publicId,
          userId: null,
          guestToken: result.guestToken,
        },
        issue.id,
        { version: issue.version, action: 'ACCEPT_ACTUAL' },
      );
      await db.orderItem.update({
        where: { id: item.id },
        data: { pieceWeights: [1200, 1800] },
      });
      await expect(
        staff.finishAssembly(result.order.id, actor()),
      ).rejects.toThrow();
      await db.orderItem.update({
        where: { id: item.id },
        data: { pieceWeights: [1250, 1750] },
      });
      await staff.finishAssembly(result.order.id, actor());
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: result.order.id } }))
          .finalSubtotal,
      ).toBe(495000);
    });
    it('reopens server cart with count and limits, applies small increments below the first portion', async () => {
      const snapshot = await cart.get(customerId);
      const saved = await cart.change(customerId, snapshot.revision, {
        kind: 'set',
        productId: wholeId,
        qty: 3,
        quantityUnit: 'PIECE',
        weightMaxGrams: 2000,
      });
      expect((await cart.get(customerId)).items[0]).toMatchObject({
        qty: 3,
        weightMaxGrams: 2000,
        quantityUnit: 'PIECE',
      });
      const loose = await cart.change(customerId, saved.revision, {
        kind: 'add',
        productId: looseId,
        qty: 500,
      });
      const plus = await cart.change(customerId, loose.revision, {
        kind: 'add',
        productId: looseId,
        qty: 100,
      });
      expect(plus.items.find((item) => item.productId === looseId)?.qty).toBe(
        600,
      );
      const order = await cart.checkout(customerId, plus.revision, buyer);
      expect(
        (
          await db.orderItem.findFirstOrThrow({
            where: { orderId: order.order.id, productId: wholeId },
          })
        ).weightMaxGrams,
      ).toBe(2000);
    });
    it('evaluates free delivery from actual goods when the whole-item estimate was unknown', async () => {
      await db.shopSettings.update({
        where: { id: 1 },
        data: {
          deliveryEnabled: true,
          freeDeliveryEnabled: true,
          freeDeliveryThreshold: 100000,
        },
      });
      const result = await orders.create(null, undefined, {
        ...buyer,
        type: 'DELIVERY',
        address: { city: 'Москва', street: 'Тестовая', house: '1' },
        items: [{ productId: wholeId, qty: 1, quantityUnit: 'PIECE' }],
      });
      expect(result.order.deliveryPrice).toBeNull();
      await db.order.update({
        where: { id: result.order.id },
        data: { status: 'ASSEMBLING' },
      });
      await staff.item(
        result.order.id,
        result.order.items[0]!.id,
        { status: 'PICKED', actualQty: 1, pieceWeights: [1780] },
        sellerId,
        actor(),
      );
      await staff.finishAssembly(result.order.id, actor());
      expect(
        await db.order.findUnique({ where: { id: result.order.id } }),
      ).toMatchObject({
        freeDeliveryApplied: true,
        deliveryPrice: 0,
        finalTotal: 293700,
      });
    });
    it('preserves legacy snapshots after changing the product model', async () => {
      const result = await orders.create(null, undefined, {
        ...buyer,
        items: [{ productId: looseId, qty: 500 }],
      });
      await db.order.update({
        where: { id: result.order.id },
        data: { status: 'ASSEMBLING' },
      });
      await db.product.update({
        where: { id: looseId },
        data: { saleModel: 'CUT_TO_WEIGHT' },
      });
      const item = result.order.items[0]!;
      await staff.item(
        result.order.id,
        item.id,
        { status: 'PICKED', actualQty: 537 },
        sellerId,
        actor(),
      );
      await staff.finishAssembly(result.order.id, actor());
      expect(
        await db.orderItem.findUnique({ where: { id: item.id } }),
      ).toMatchObject({
        saleModel: null,
        unit: 'GRAM',
        qty: 500,
        actualQty: 537,
        actualTotal: 5907,
      });
    });
    it('requires explicit reselection when a saved specimen count changes to grams', async () => {
      const categoryId = (
        await db.product.findUniqueOrThrow({ where: { id: wholeId } })
      ).categoryId;
      const product = await db.product.create({
        data: {
          name: 'Смена режима',
          slug: 'mode-switch',
          categoryId,
          price: 150000,
          unit: 'PIECE',
          priceUnit: 'GRAM',
          saleModel: 'WHOLE_VARIABLE_WEIGHT',
          priceQty: 1000,
          min: 1,
          step: 1,
          portionQty: 1,
        },
      });
      const user = await db.user.create({ data: {} });
      const first = await cart.get(user.id);
      const saved = await cart.change(user.id, first.revision, {
        kind: 'set',
        productId: product.id,
        qty: 2,
        quantityUnit: 'PIECE',
        weightMaxGrams: 2000,
      });
      await db.product.update({
        where: { id: product.id },
        data: { unit: 'GRAM', saleModel: 'CUT_TO_WEIGHT' },
      });
      expect((await cart.get(user.id)).valid).toBe(false);
      await expect(
        cart.change(user.id, saved.revision, {
          kind: 'plus',
          productId: product.id,
        }),
      ).rejects.toThrow();
      const fixed = await cart.change(user.id, saved.revision, {
        kind: 'set',
        productId: product.id,
        qty: 500,
        weightMinGrams: null,
        weightMaxGrams: null,
      });
      expect(fixed.valid).toBe(true);
      expect(fixed.items[0]!.qty).toBe(500);
    });
    it('dry-run and repeated application preserve price, activity and later admin corrections', async () => {
      const p = await db.product.create({
        data: {
          name: 'Бутылка 1 л',
          slug: 'safe-pack',
          price: 12345,
          priceStatus: 'AUDITED',
          unit: 'PIECE',
          priceQty: 1,
          min: 1,
          step: 1,
          portionQty: 1,
          active: false,
          categoryId: (
            await db.product.findUniqueOrThrow({ where: { id: wholeId } })
          ).categoryId,
        },
      });
      const before = {
        unit: 'PIECE' as const,
        priceQty: 1,
        min: 1,
        step: 1,
        portionQty: 1,
        saleModel: null,
        priceUnit: null,
      };
      const plan: SalePlan = {
        version: 1,
        localOnly: true,
        databaseCheckedAt: new Date().toISOString(),
        patches: [
          {
            productId: p.id,
            slug: p.slug,
            name: p.name,
            expectedUpdatedAt: p.updatedAt.toISOString(),
            sourceUrl: null,
            before,
            after: {
              ...before,
              unit: 'PACK',
              priceUnit: 'PACK',
              saleModel: 'PACK',
            },
            status: 'CONFIRMED',
            evidenceIds: ['fixture'],
          },
        ],
      };
      expect((await applyPlan(db, plan)).changed).toBe(1);
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: p.id } })).unit,
      ).toBe('PIECE');
      await applyPlan(db, plan, true);
      expect(
        await db.product.findUnique({ where: { id: p.id } }),
      ).toMatchObject({
        unit: 'PACK',
        price: 12345,
        priceStatus: 'AUDITED',
        active: false,
      });
      expect((await applyPlan(db, plan, true)).unchanged).toBe(1);
      await db.product.update({ where: { id: p.id }, data: { portionQty: 2 } });
      expect((await applyPlan(db, plan, true)).skipped).toBe(1);
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: p.id } }))
          .portionQty,
      ).toBe(2);
    });
    it('rejects hidden-category quotes, cart changes, merges and checkout while retaining existing orders', async () => {
      const product = await db.product.findUniqueOrThrow({ where: { id: looseId } });
      const snapshot = await cart.get(customerId);
      await db.category.update({ where: { id: product.categoryId }, data: { active: false } });
      try {
        const quote = await orders.quote({ items: [{ productId: looseId, qty: 500 }] });
        expect(quote.valid).toBe(false);
        expect(quote.items[0]?.status).toBe('UNAVAILABLE');
        await expect(orders.create(null, undefined, { ...buyer, items: [{ productId: looseId, qty: 500 }] })).rejects.toThrow();
        await expect(cart.change(customerId, snapshot.revision, { kind: 'add', productId: looseId, qty: 500 })).rejects.toThrow();
        const freshUser = (await db.user.create({ data: {} })).id;
        const fresh = await cart.get(freshUser);
        await expect(cart.merge(freshUser, fresh.revision, [{ productId: looseId, qty: 500 }])).rejects.toThrow();
      } finally { await db.category.update({ where: { id: product.categoryId }, data: { active: true } }); }
    });

    it('sorts actual price bases consistently and recomputes the derived price on edits', async () => {
      const category = await db.category.create({ data: { name: 'Sort audit', slug: 'sort-audit' } });
      const base = { categoryId: category.id, unit: 'GRAM' as const, min: 100, step: 100, portionQty: 100 };
      const small = await db.product.create({ data: { ...base, name: 'Sort audit expensive', slug: 'sort-small', price: 9000, priceQty: 100 } });
      const kilo = await db.product.create({ data: { ...base, name: 'Sort audit cheap', slug: 'sort-kilo', price: 50000, priceQty: 1000 } });
      const products = new ProductService(db as unknown as DbService);
      const query = productQuerySchema.parse({ category: category.slug, sort: 'price_asc' });
      expect((await products.list(query)).items.map(item => item.id)).toEqual([kilo.id, small.id]);
      expect((await products.list({ ...query, feed: 'catalog' })).items.filter(item => item.category.slug === category.slug).map(item => item.id)).toEqual([kilo.id, small.id]);
      const changed = await db.product.update({ where: { id: small.id }, data: { priceQty: 1000 } });
      expect(Number(changed.normalizedPrice)).toBe(9900);
      expect((await products.list(query)).items.map(item => item.id)).toEqual([small.id, kilo.id]);
    });

    it('preserves concurrent review fields, rejects stale versions and records the actor', async () => {
      const service = new ResearchDraftsService(db as unknown as DbService);
      const key = 'review-concurrency';
      const initial = await db.researchStoreDraft.create({ data: { key, datasetId: 'bagrationovsky-2026-10-11', source: {},
        review: { status: 'PENDING', marketPointId: null, productId: null, confirmedSku: null, notes: null, reviewedOn: null } } });
      await Promise.all([service.storeReview(key, { status: 'VERIFIED' }, sellerId), service.storeReview(key, { notes: 'Concurrent note' }, sellerId)]);
      expect((await db.researchStoreDraft.findUniqueOrThrow({ where: { key } })).review).toMatchObject({ status: 'VERIFIED', notes: 'Concurrent note' });
      await expect(service.storeReview(key, { status: 'REJECTED', expectedUpdatedAt: initial.updatedAt.toISOString() }, sellerId)).rejects.toThrow('Черновик уже изменён');
      expect(await db.adminAudit.count({ where: { entityId: key, actorId: sellerId } })).toBe(2);
    });
  },
);
