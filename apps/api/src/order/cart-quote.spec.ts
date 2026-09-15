import { DbService } from '../db/db.service.js';
import { OrderService } from './order.service.js';
import {
  quoteSchema,
  cartQuote,
  cartQuantities,
  cartQuantityValid,
} from './cart-quote.js';
import { orderSchema } from './schema.js';

const product = {
  id: 1,
  name: 'Яблоки',
  slug: 'apples',
  price: 350000,
  priceQty: 1000,
  unit: 'GRAM' as const,
  min: 500,
  step: 300,
  portionQty: 500,
  images: [],
  category: { name: 'Фрукты', slug: 'fruit' },
};
const calculate = (qty = 1100, changes = {}) =>
  cartQuote(new Map([[1, qty]]), [{ ...product, ...changes }]);

describe('Current server cart quote', () => {
  it('strips client prices; one product query feeds quote and order pricing', async () => {
    const findMany = vi.fn().mockResolvedValue([product]);
    const service = new OrderService({
      product: { findMany },
    } as unknown as DbService);
    const body = quoteSchema.parse({
      items: [{ productId: 1, qty: 1100, price: 1, lineTotal: 1 }],
      subtotal: 1,
    });
    expect(body).toEqual({ items: [{ productId: 1, qty: 1100 }] });
    expect(await service.quote(body)).toMatchObject({
      valid: true,
      subtotal: 385000,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { active: true, id: { in: [1] } },
    });
    findMany.mockResolvedValue([{ ...product, price: 250000 }]);
    expect(await service.quote(body)).toMatchObject({ subtotal: 275000 });
  });
  it('priceQty and price changes affect exact totals and fingerprint', () => {
    const first = calculate();
    const second = calculate(1100, { priceQty: 500 });
    expect(second.subtotal).toBe(770000);
    expect(second.token).not.toBe(first.token);
  });
  it.each([
    { price: 15000, priceQty: 500, totals: [15000, 30000, 45000] },
    { price: 19900, priceQty: 1000, totals: [9950, 19900, 29850] },
  ])('prices quantities in base units for $price/$priceQty', ({ price, priceQty, totals }) => {
    for (const [index, qty] of [500, 1000, 1500].entries()) {
      expect(calculate(qty, { price, priceQty, step: 100 }).subtotal).toBe(totals[index]);
    }
  });
  it('portion changes invalidate the fingerprint without changing the requested quantity or price', () => {
    const before = calculate(700, { step: 100 });
    const after = calculate(700, { step: 100, portionQty: 1000 });
    expect(after.subtotal).toBe(before.subtotal);
    expect(after.items[0]!.qty).toBe(700);
    expect(after.token).not.toBe(before.token);
  });
  it('rejects tampered quantities using database rules before any order write', async () => {
    const create = vi.fn();
    const db = {
      product: { findMany: vi.fn().mockResolvedValue([{ ...product, step: 100 }]) },
      order: { create },
    } as unknown as DbService;
    const input = orderSchema.parse({
      type: 'PICKUP', customerName: 'Иван', customerPhone: '+79991234567',
      items: [{ productId: 1, qty: 501, min: 1, step: 1, portionQty: 1, price: 1 }],
    });
    await expect(new OrderService(db).create(42, undefined, input)).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });
  it('unavailable/hidden/deleted IDs expose neither product nor partial eligibility subtotal', () => {
    const quote = cartQuote(
      new Map([
        [1, 1100],
        [2, 1],
      ]),
      [product],
    );
    expect(quote.items[1]).toEqual({
      productId: 2,
      qty: 1,
      product: null,
      status: 'UNAVAILABLE',
      lineTotal: null,
    });
    expect(quote).toMatchObject({ subtotal: null, valid: false, token: null });
  });
  it.each([0, -1, 500.5, 1000, 1000001])(
    'returns a structured quantity error for %s',
    (qty) => {
      expect(calculate(qty)).toMatchObject({
        subtotal: null,
        items: [{ qty, status: 'INVALID_QUANTITY', lineTotal: null }],
      });
    },
  );
  it.each([500, 800, 1100])('accepts min + k * step, including %s', (qty) => {
    expect(cartQuantityValid(qty, 500, 300)).toBe(true);
    expect(calculate(qty).valid).toBe(true);
  });
  it('uses exact half-up integer rounding, never client floating-point totals', () => {
    expect(
      calculate(1, { min: 1, step: 1, price: 1, priceQty: 2 }).subtotal,
    ).toBe(1);
    expect(
      calculate(1000000, {
        min: 1,
        step: 1,
        price: 2147483647,
        priceQty: 1000000,
      }).subtotal,
    ).toBe(2147483647);
  });
  it('reports line and total overflow without an unhandled Prisma/database error', () => {
    expect(calculate(1100, { price: 2147483647, priceQty: 1 })).toMatchObject({
      valid: false,
      items: [{ status: 'PRICE_OVERFLOW' }],
    });
    const p = { ...product, min: 1, step: 1, price: 2147483647, priceQty: 1 };
    expect(
      cartQuote(
        new Map([
          [1, 1],
          [2, 1],
        ]),
        [p, { ...p, id: 2 }],
      ),
    ).toMatchObject({ subtotal: null, error: 'TOTAL_OVERFLOW', token: null });
  });
  it('validates the aggregate of duplicate input IDs before pricing', () => {
    const amounts = cartQuantities([
      { productId: 1, qty: 500 },
      { productId: 1, qty: 500 },
    ]);
    expect(cartQuote(amounts, [product]).items[0]!.status).toBe(
      'INVALID_QUANTITY',
    );
  });
  it('checks a quote fingerprint against fresh data before any order/guest write', async () => {
    const create = vi.fn();
    const db = {
      product: {
        findMany: vi.fn().mockResolvedValue([{ ...product, price: 250000 }]),
      },
      order: { create },
    } as unknown as DbService;
    const input = orderSchema.parse({
      type: 'PICKUP',
      customerName: 'Иван',
      customerPhone: '+79991234567',
      items: [{ productId: 1, qty: 1100 }],
      quoteToken: calculate().token,
    });
    await expect(
      new OrderService(db).create(null, undefined, input),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CART_CHANGED' },
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('bounds request size and IDs without trusting extra fields', () => {
    expect(quoteSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      quoteSchema.safeParse({
        items: Array.from({ length: 51 }, () => ({ productId: 1, qty: 1 })),
      }).success,
    ).toBe(false);
    expect(
      quoteSchema.safeParse({ items: [{ productId: 2147483648, qty: 1 }] })
        .success,
    ).toBe(false);
  });
});
