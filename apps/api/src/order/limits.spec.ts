import { checkoutLimits, extraLimits } from './limits.js';
import { settingsSchema } from '../admin/settings.schema.js';
import { goodsLine } from './pricing.js';

const settings = {
  minDeliverySubtotal: 300000,
  deliveryEnabled: true,
  pickupEnabled: true,
  maxOrderExtraUnitPrice: 500000,
  maxOrderExtrasTotal: 1000000,
};
describe('business limits', () => {
  it.each([299900, 300000, 300100])('delivery boundary %i', (subtotal) => {
    const run = () => checkoutLimits('DELIVERY', subtotal, settings);
    if (subtotal < 300000) expect(run).toThrow();
    else expect(run).not.toThrow();
  });
  it('pickup has no minimum; disabled methods are rejected; zero minimum works', () => {
    expect(() => checkoutLimits('PICKUP', 100000, settings)).not.toThrow();
    expect(() =>
      checkoutLimits('DELIVERY', 100, { ...settings, minDeliverySubtotal: 0 }),
    ).not.toThrow();
    expect(() =>
      checkoutLimits('DELIVERY', 900000, {
        ...settings,
        deliveryEnabled: false,
      }),
    ).toThrow();
    expect(() =>
      checkoutLimits('PICKUP', 900000, { ...settings, pickupEnabled: false }),
    ).toThrow();
  });
  it('exact extra limits, edit replacement and overflow', () => {
    expect(() =>
      extraLimits(500000, 500000, 500000n, null, settings),
    ).not.toThrow();
    expect(() => extraLimits(500001, 500001, 0n, null, settings)).toThrow();
    expect(() =>
      extraLimits(500000, 500000, 500001n, null, settings),
    ).toThrow();
    expect(() =>
      extraLimits(
        500000,
        500000,
        1000000n,
        { unitPrice: 500000, amount: 500000 },
        settings,
      ),
    ).not.toThrow();
    expect(() => goodsLine(2147483647, 10000, 1)).toThrow();
  });
  it('allows strict reduction of old violations, not increases', () => {
    const current = { unitPrice: 700000, amount: 1400000 };
    expect(() =>
      extraLimits(600000, 1200000, 1400000n, current, settings),
    ).not.toThrow();
    expect(() =>
      extraLimits(700001, 1400002, 1400000n, current, settings),
    ).toThrow();
  });
  it.each([-1, 0.5, 100000001])('invalid minimum %s', (minDeliverySubtotal) => {
    expect(settingsSchema.safeParse({ minDeliverySubtotal }).success).toBe(
      false,
    );
  });
});
