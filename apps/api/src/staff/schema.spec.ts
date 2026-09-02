import { deliverySchema, itemSchema } from './schema.js';

describe('staff schemas', () => {
  it('accepts an arbitrary positive integer weight', () => {
    expect(
      itemSchema.parse({
        status: 'PICKED',
        actualQty: 1063,
      }),
    ).toEqual({
      status: 'PICKED',
      actualQty: 1063,
    });
  });

  it('accepts returning an item to pending', () => {
    expect(itemSchema.parse({ status: 'PENDING' })).toEqual({
      status: 'PENDING',
    });
  });

  it('accepts Yandex delivery with only an HTTPS tracking URL', () => {
    expect(
      deliverySchema.safeParse({
        provider: 'YANDEX',
        trackingUrl: 'https://example.com/track',
      }).success,
    ).toBe(true);
  });

  it('rejects Yandex delivery without a tracking URL', () => {
    expect(
      deliverySchema.safeParse({
        provider: 'YANDEX',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-HTTPS Yandex tracking URL', () => {
    expect(
      deliverySchema.safeParse({
        provider: 'YANDEX',
        trackingUrl: 'http://example.com/track',
      }).success,
    ).toBe(false);
  });

  it('accepts another provider without tracking and normalizes its phone', () => {
    const result = deliverySchema.safeParse({
      provider: 'OTHER',
      courierName: 'Александр',
      courierPhone: '8 (999) 123-45-67',
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toEqual({
        provider: 'OTHER',
        courierName: 'Александр',
        courierPhone: '+79991234567',
      });
    }
  });

  it('rejects another provider without a courier name', () => {
    expect(
      deliverySchema.safeParse({
        provider: 'OTHER',
        courierPhone: '+79991234567',
      }).success,
    ).toBe(false);
  });

  it('rejects another provider without a courier phone', () => {
    expect(
      deliverySchema.safeParse({
        provider: 'OTHER',
        courierName: 'Александр',
      }).success,
    ).toBe(false);
  });

  it('accepts an HTTP tracking URL for another provider', () => {
    expect(
      deliverySchema.safeParse({
        provider: 'OTHER',
        courierName: 'Александр',
        courierPhone: '+79991234567',
        trackingUrl: 'http://example.com/track',
      }).success,
    ).toBe(true);
  });
});
