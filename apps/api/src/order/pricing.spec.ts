import {
  deliveryTotals,
  positiveDeliveryPrice,
  totalWithDelivery,
} from './pricing.js';

describe('order pricing', () => {
  it.each([null, undefined, 0, -1, NaN, Infinity, 1.5, 2_147_483_648])(
    'rejects invalid delivery price %s',
    (price) => {
      expect(() => positiveDeliveryPrice(price)).toThrow();
    },
  );

  it('distinguishes unknown delivery from free pickup', () => {
    expect(totalWithDelivery(245_000, null)).toBeNull();
    expect(totalWithDelivery(245_000, 0)).toBe(245_000);
  });

  it('keeps the final total unknown until assembly is finished', () => {
    expect(
      deliveryTotals({ subtotal: 245_000, finalSubtotal: null }, 48_700),
    ).toEqual({
      deliveryPrice: 48_700,
      total: 293_700,
      finalTotal: null,
    });
  });

  it('recalculates both totals when a provider revises its price', () => {
    const order = { subtotal: 245_000, finalSubtotal: 240_000 };
    expect(deliveryTotals(order, 48_700)).toEqual({
      deliveryPrice: 48_700,
      total: 293_700,
      finalTotal: 288_700,
    });
    expect(deliveryTotals(order, 50_000)).toEqual({
      deliveryPrice: 50_000,
      total: 295_000,
      finalTotal: 290_000,
    });
  });

  it('rejects totals outside the database integer range', () => {
    expect(() =>
      deliveryTotals({ subtotal: 2_147_483_647, finalSubtotal: null }, 1),
    ).toThrow();
  });
});
