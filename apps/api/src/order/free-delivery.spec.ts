import { freeDelivery } from './free-delivery.js';
import { deliveryTotals } from './pricing.js';
import { customerPrice } from '../product/pricing.js';

const settings = { deliveryEnabled: true, freeDeliveryEnabled: true, freeDeliveryThreshold: 300_050 };
describe('Free delivery in integer kopecks', () => {
  it.each([299_999, 300_049])('reports the exact remainder below the threshold: %s', subtotal => {
    expect(freeDelivery(subtotal, settings)).toMatchObject({ eligible: false, remaining: 300_050 - subtotal, price: null, total: null });
  });
  it.each([300_050, 300_051, 500_000])('waives delivery at and above the threshold: %s', subtotal => {
    expect(freeDelivery(subtotal, settings)).toMatchObject({ eligible: true, remaining: 0, price: 0, total: subtotal, progress: 100 });
  });
  it('only uses customer goods totals and never marks an invalid cart eligible', () => {
    const subtotal = customerPrice(272_773);
    expect(subtotal).toBe(300_050);
    expect(freeDelivery(subtotal, settings).eligible).toBe(true);
    expect(freeDelivery(null, settings)).toMatchObject({ remaining: null, eligible: false, price: null });
    expect(freeDelivery(500_000, { ...settings, freeDeliveryEnabled: false }).enabled).toBe(false);
    expect(freeDelivery(500_000, { ...settings, deliveryEnabled: false }).enabled).toBe(false);
    expect(freeDelivery(500_000, { ...settings, freeDeliveryThreshold: null }).enabled).toBe(false);
  });
  it('retains carrier fees while preserving the checkout snapshot for customer totals', () => {
    expect(deliveryTotals({ subtotal: 300_050, finalSubtotal: 290_000, freeDeliveryApplied: true }, 48_765))
      .toEqual({ deliveryPrice: 0, total: 300_050, finalTotal: 290_000 });
    expect(deliveryTotals({ subtotal: 300_050, finalSubtotal: 290_000 }, 48_765))
      .toEqual({ deliveryPrice: 48_765, total: 348_815, finalTotal: 338_765 });
  });
});
