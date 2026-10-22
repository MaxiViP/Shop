import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import type { DbService } from '../db/db.service.js';
import type { OrderService } from '../order/order.service.js';
import { CartService } from './cart.service.js';
import { QuickShopCtrl, repeatCartSchema } from './quick-shop.ctrl.js';
import { QuickShopService } from './quick-shop.service.js';

const revision = 'dc427781-b7dd-4d96-9aa0-be07528e9856';
const product = {
  id: 1, name: 'Помидоры', slug: 'tomatoes', price: 32000, priceQty: 1000,
  unit: 'GRAM' as const, priceUnit: 'GRAM' as const, saleModel: 'WEIGHT_LOOSE' as const,
  min: 250, step: 250, portionQty: 500, estimatedWeightGrams: null,
  priceStatus: 'ESTIMATED' as const, serviceMarkupPercent: 10,
  isSeasonal: false, isHit: false, hitMode: 'OFF' as const, seasonalMode: 'OFF' as const,
  seasonalStartsAt: null, seasonalEndsAt: null, seasonTemplate: null,
  images: [], category: { name: 'Овощи', slug: 'vegetables' }, marketPoint: null,
};
const previous = {
  productId: 1, productName: 'Старое название', qty: 750, unit: 'GRAM' as const,
  priceUnit: 'GRAM' as const, saleModel: 'WEIGHT_LOOSE' as const,
  weightMinGrams: null, weightMaxGrams: null,
};

function setup() {
  const db = {
    order: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    favorite: { findMany: vi.fn().mockResolvedValue([]) },
    product: { findMany: vi.fn().mockResolvedValue([product]) },
  };
  const basket = { revision, items: [] as { productId: number; qty: number }[] };
  const cart = { get: vi.fn().mockResolvedValue(basket), merge: vi.fn().mockResolvedValue({ ...basket, revision: 'updated' }) };
  return { db, cart, basket,
    service: new QuickShopService(db as unknown as DbService, cart as unknown as CartService) };
}

describe('quick shopping suggestions', () => {
  it('uses current customer prices and requested quantity from own completed orders', async () => {
    const s = setup();
    s.db.order.findMany.mockResolvedValue([{ items: [{ ...previous, actualQty: 777 }] }]);
    s.db.order.findFirst.mockResolvedValue({ id: 45, createdAt: new Date('2026-10-21T07:00:00Z'), _count: { items: 1 } });
    const result = await s.service.get(7);
    expect(result.items).toMatchObject([{ source: 'frequent', suggestedQty: 750,
      product: { name: 'Помидоры', price: 35200 }, lineTotal: 26400 }]);
    expect(result.cart).toBe(s.basket);
    expect(result.lastOrder).toMatchObject({ id: 45, itemCount: 1 });
    expect(s.db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7, status: 'COMPLETED' }, take: 30,
    }));
    expect(s.db.favorite.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 7 }, take: 24 }));
  });

  it('counts distinct orders rather than duplicate rows, with stable frequency ranking', async () => {
    const s = setup();
    s.db.order.findMany.mockResolvedValue([
      { items: [previous, previous, { ...previous, productId: 2 }] },
      { items: [{ ...previous, productId: 2 }] },
    ]);
    s.db.product.findMany.mockResolvedValueOnce([product, { ...product, id: 2, name: 'Огурцы' }]).mockResolvedValue([]);
    expect((await s.service.get(7)).items.map(item => item.product.id)).toEqual([2, 1]);
  });

  it('uses favorites without order history and falls back to the catalog', async () => {
    const s = setup();
    s.db.favorite.findMany.mockResolvedValue([{ productId: 1 }]);
    s.db.product.findMany.mockResolvedValueOnce([product]).mockResolvedValueOnce([{ ...product, id: 2 }]);
    const result = await s.service.get(7);
    expect(result.items.map(item => item.source)).toEqual(['favorite', 'catalog']);
    expect(result.lastOrder).toBeNull();
    expect(s.db.product.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { active: true, category: { active: true }, id: { notIn: [1] } }, take: 23,
    }));
  });

  it('normalizes a stale or invalid previous quantity to the current configured portion', async () => {
    const s = setup();
    s.db.order.findMany.mockResolvedValue([{ items: [{ ...previous, qty: 333 }] }]);
    expect((await s.service.get(7)).items[0]?.suggestedQty).toBe(500);
  });

  it('prefers a valid configured portion without history and otherwise uses the minimum', async () => {
    const s = setup();
    expect((await s.service.get(7)).items[0]).toMatchObject({ suggestedQty: 500, lineTotal: 17600 });
    s.db.product.findMany.mockResolvedValue([{ ...product, portionQty: 333 }]);
    expect((await s.service.get(7)).items[0]?.suggestedQty).toBe(250);
    s.db.product.findMany.mockResolvedValue([{ ...product, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT',
      min: 1, step: 1, portionQty: 101 }]);
    expect((await s.service.get(7)).items[0]?.suggestedQty).toBe(1);
  });

  it('keeps whole variable weight pricing unknown without a verified weight estimate', async () => {
    const s = setup();
    s.db.product.findMany.mockResolvedValue([{ ...product, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1, portionQty: 1 }]);
    const result = await s.service.get(7);
    expect(result.items[0]).toMatchObject({ suggestedQty: 1, lineTotal: null,
      product: { unit: 'PIECE', priceUnit: 'GRAM' } });
    expect(s.cart.merge).not.toHaveBeenCalled();
  });
});

describe('repeat an owned order into the current cart', () => {
  it('uses ordered quantity and fresh terms, never actual weight or historical prices', async () => {
    const s = setup();
    s.db.order.findFirst.mockResolvedValue({ id: 45, items: [{ ...previous, actualQty: 777, price: 1 }] });
    const result = await s.service.repeat(7, revision, 45);
    expect(s.db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7, id: 45, status: { not: 'CANCELED' } },
    }));
    expect(s.cart.merge).toHaveBeenCalledWith(7, revision,
      [{ productId: 1, qty: 750, quantityUnit: 'GRAM' }],
      [{ productId: 1, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE' }]);
    expect(result).toMatchObject({ orderId: 45, added: 1, skipped: [], cart: { revision: 'updated' } });
  });

  it('rejects a missing or foreign order without reading or modifying the cart', async () => {
    const s = setup();
    await expect(s.service.repeat(7, revision, 999)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.cart.get).not.toHaveBeenCalled();
    expect(s.cart.merge).not.toHaveBeenCalled();
  });

  it('rejects stale cart revisions before product reads or mutations', async () => {
    const s = setup();
    s.db.order.findFirst.mockResolvedValue({ id: 45, items: [previous] });
    await expect(s.service.repeat(7, 'stale')).rejects.toMatchObject({ status: 409 });
    expect(s.db.product.findMany).not.toHaveBeenCalled();
    expect(s.cart.merge).not.toHaveBeenCalled();
  });

  it('retains existing quantities and reports missing, changed-unit and invalid-step rows', async () => {
    const s = setup();
    s.basket.items = [{ productId: 1, qty: 5000 }];
    s.db.order.findFirst.mockResolvedValue({ id: 45, items: [previous,
      { ...previous, productId: 2, productName: 'Удалённый' },
      { ...previous, productId: 3, productName: 'Изменённый' },
      { ...previous, productId: 4, productName: 'Другой шаг', qty: 333 },
      { ...previous, productId: null, productName: 'Исторический' },
    ] });
    s.db.product.findMany.mockResolvedValue([product,
      { ...product, id: 3, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1 },
      { ...product, id: 4 }]);
    const result = await s.service.repeat(7, revision);
    expect(result.added).toBe(0);
    expect(result.skipped).toHaveLength(5);
    expect(result.skipped[0]?.reason).toContain('количество сохранено');
    expect(result.skipped[1]?.reason).toContain('недоступен');
    expect(result.skipped[2]?.reason).toContain('Способ продажи');
    expect(result.skipped[3]?.reason).toContain('шаг');
    expect(s.cart.merge).toHaveBeenCalledWith(7, revision, [], []);
  });

  it('preserves weight preferences for a whole variable item and refuses more than 100 pieces', async () => {
    const s = setup();
    const whole = { ...product, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1, portionQty: 1 };
    const item = { ...previous, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', qty: 2,
      weightMinGrams: 500, weightMaxGrams: 1000 };
    s.db.product.findMany.mockResolvedValue([whole]);
    s.db.order.findFirst.mockResolvedValue({ id: 45, items: [item] });
    await s.service.repeat(7, revision);
    expect(s.cart.merge).toHaveBeenCalledWith(7, revision,
      [expect.objectContaining({ qty: 2, quantityUnit: 'PIECE', weightMinGrams: 500, weightMaxGrams: 1000 })], expect.any(Array));
    s.db.order.findFirst.mockResolvedValue({ id: 45, items: [{ ...item, qty: 101 }] });
    expect((await s.service.repeat(7, revision)).skipped[0]?.reason).toContain('количество');
  });

  it('does not exceed the cart product limit', async () => {
    const s = setup();
    s.basket.items = Array.from({ length: 50 }, (_, i) => ({ productId: i + 2, qty: 1 }));
    s.db.order.findFirst.mockResolvedValue({ id: 45, items: [previous] });
    const result = await s.service.repeat(7, revision);
    expect(result.added).toBe(0);
    expect(result.skipped[0]?.reason).toContain('50');
  });
});

it('rechecks the sale model under the merge product lock before cart writes', async () => {
  const cart = { id: 1, revision, items: [] };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: 1 }]),
    cart: { upsert: vi.fn().mockResolvedValue(cart), findUniqueOrThrow: vi.fn().mockResolvedValue(cart), update: vi.fn() },
    product: { findMany: vi.fn().mockResolvedValue([{ id: 1, unit: 'PIECE', priceUnit: 'GRAM',
      saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1 }]) },
    cartItem: { createMany: vi.fn() },
  };
  const db = { $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) };
  const service = new CartService(db as unknown as DbService, {} as OrderService);
  await expect(service.merge(7, revision, [{ productId: 1, qty: 1, quantityUnit: 'PIECE' }],
    [{ productId: 1, unit: 'PIECE', priceUnit: 'PIECE', saleModel: 'PIECE_FIXED' }]))
    .rejects.toMatchObject({ status: 409 });
  expect(tx.cartItem.createMany).not.toHaveBeenCalled();
  expect(tx.cart.update).not.toHaveBeenCalled();
});

describe('quick shopping routes', () => {
  it('requires authentication and rejects staff identities before reading customer data', () => {
    const quick = { get: vi.fn(), repeat: vi.fn() };
    const ctrl = new QuickShopCtrl(quick as unknown as QuickShopService);
    expect(Reflect.getMetadata('__guards__', QuickShopCtrl)).toEqual([AuthGuard]);
    for (const role of ['SELLER', 'ADMIN']) {
      const request = { user: { id: 7, role } } as unknown as AuthRequest;
      expect(() => ctrl.get(request)).toThrow(ForbiddenException);
      expect(() => ctrl.repeat(request, { revision })).toThrow(ForbiddenException);
    }
    expect(quick.get).not.toHaveBeenCalled();
    expect(quick.repeat).not.toHaveBeenCalled();
  });

  it('accepts only a valid revision and optional integer order id', () => {
    expect(repeatCartSchema.parse({ revision, orderId: 45, userId: 99, price: 1 }))
      .toEqual({ revision, orderId: 45 });
    for (const invalid of [{}, { revision: 'bad' }, { revision, orderId: -1 }, { revision, orderId: 1.5 }])
      expect(repeatCartSchema.safeParse(invalid).success).toBe(false);
  });
});
