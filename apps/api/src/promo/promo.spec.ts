import { discountAmount, payableGoods, assembledDiscount } from './promo.js';
import { promoIssueSchema } from './schema.js';
const fixed = { type: 'FIXED' as const, amount: 5000, percentBps: null, maxDiscount: null, minSubtotal: 0 };
const percent = { type: 'PERCENT' as const, amount: null, percentBps: 1250, maxDiscount: 3000, minSubtotal: 0 };
describe('personal promo money', () => {
  it('caps a fixed compensation at goods, including zero, without negative totals', () => {
    expect(discountAmount(2000, fixed)).toBe(2000);
    expect(discountAmount(0, fixed)).toBe(0);
    expect(discountAmount(10000, fixed)).toBe(5000);
  });
  it('rounds a percentage once to a kopeck, half up, and respects the cap', () => {
    expect(discountAmount(10004, percent)).toBe(1251);
    expect(discountAmount(10003, percent)).toBe(1250);
    expect(discountAmount(100000, percent)).toBe(3000);
  });
  it('calculates accurately at the PostgreSQL Int boundary', () => {
    expect(discountAmount(2147483647, { ...percent, percentBps: 10000, maxDiscount: 2147483647 })).toBe(2147483647);
    expect(() => discountAmount(2147483648, fixed)).toThrow();
  });
  it('uses the captured terms after assembly and preserves legacy payments', () => {
    expect(assembledDiscount({ promoTypeSnapshot: 'PERCENT', promoPercentBpsSnapshot: 1250, promoMaxDiscountSnapshot: 10000 }, 10004)).toBe(1251);
    expect(assembledDiscount({}, 10004)).toBe(0);
    expect(payableGoods({ finalSubtotal: 10000 })).toBe(10000);
    expect(payableGoods({ finalSubtotal: 10000, promoDiscount: 5000, finalPromoDiscount: 2000 })).toBe(8000);
    expect(payableGoods({ finalSubtotal: null, promoDiscount: 5000 })).toBeNull();
  });
  const issue = { userId: 1, title: 'Компенсация', type: 'FIXED', amount: 5000,
    expiresAt: '2099-01-01T00:00:00.000Z', reason: 'Внутренняя причина' };
  it.each([
    { amount: 0 }, { amount: -1 }, { type: 'PERCENT', amount: null, percentBps: 1000 },
    { type: 'PERCENT', amount: null, percentBps: 10001, maxDiscount: 10000 },
    { expiresAt: '2000-01-01T00:00:00.000Z' }, { promoCodeIds: [1, 2] },
  ])('rejects invalid administrative terms %j', changes => {
    expect(promoIssueSchema.safeParse({ ...issue, ...changes }).success).toBe(false);
  });
});
