import { DbService } from '../db/db.service.js';
import { OrderService } from './order.service.js';
import { orderSchema } from './schema.js';

describe('OrderService creation', () => {
  it.each([
    { type: 'PICKUP', deliveryAt: undefined },
    { type: 'PICKUP', deliveryAt: '2099-09-05T15:30:00.000Z' },
    { type: 'DELIVERY', deliveryAt: undefined },
  ] as const)(
    'calculates $type totals and saves requested time $deliveryAt',
    async ({ type, deliveryAt }) => {
      const create = vi
        .fn()
        .mockImplementation(({ data }) => ({ id: 1, ...data }));
      const db = {
        shopSettings: {
          findUniqueOrThrow: vi
            .fn()
            .mockResolvedValue({ weightToleranceBps: 1000, minDeliverySubtotal: 0, deliveryEnabled: true, pickupEnabled: true }),
        },
        product: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 1,
              name: 'Яблоки',
              slug: 'apples',
              price: 45_000,
              priceQty: 1_000,
              unit: 'GRAM',
              min: 500,
              step: 500,
              portionQty: 500,
              images: [],
            },
          ]),
        },
        order: { create },
      } as unknown as DbService;
      const input = orderSchema.parse({
        type,
        customerName: '  Александр  ',
        customerPhone: '+79991234567',
        address:
          type === 'DELIVERY'
            ? { city: 'Москва', street: 'Рыночная', house: '1' }
            : undefined,
        deliveryAt,
        items: [{ productId: 1, qty: 1_000 }],
        deliveryPrice: 0,
        total: 1,
        finalTotal: 1,
      });
      const { order } = await new OrderService(db).create(42, undefined, input);
      expect(order).toMatchObject({
        customerName: 'Александр',
        subtotal: 45_000,
        deliveryPrice: type === 'PICKUP' ? 0 : null,
        total: type === 'PICKUP' ? 45_000 : null,
        deliveryAt: deliveryAt ? new Date(deliveryAt) : null,
      });
      expect(input).not.toHaveProperty('deliveryPrice');
      expect(input).not.toHaveProperty('total');
      expect(input).not.toHaveProperty('finalTotal');
      expect(create.mock.calls[0]?.[0].data).not.toHaveProperty('status');
      if (type === 'PICKUP')
        expect(create.mock.calls[0]?.[0].data.city).toBeUndefined();
    },
  );
});

describe('pickup time validation', () => {
  it.each([
    '2000-01-01T00:00:00Z',
    'invalid',
    '2099-02-30T12:00:00Z',
    new Date().toISOString(),
  ])('rejects nonfuture or invalid time %s', (deliveryAt) => {
    expect(
      orderSchema.safeParse({
        type: 'PICKUP',
        customerName: 'Иван',
        customerPhone: '+79991234567',
        items: [{ productId: 1, qty: 1000 }],
        deliveryAt,
      }).success,
    ).toBe(false);
  });
  it('still requires a DELIVERY address', () => {
    expect(
      orderSchema.safeParse({
        type: 'DELIVERY',
        customerName: 'Иван',
        customerPhone: '+79991234567',
        items: [{ productId: 1, qty: 1000 }],
      }).success,
    ).toBe(false);
  });
});
