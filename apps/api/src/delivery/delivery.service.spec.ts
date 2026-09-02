import { NotFoundException } from '@nestjs/common';
import type { DeliveryStatus, OrderStatus } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { DeliveryService } from './delivery.service.js';
import type { YandexClaimInfo } from './yandex.service.js';
import { YandexService } from './yandex.service.js';

function yandexMock(claim: YandexClaimInfo) {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    isSyncAvailable: vi.fn().mockReturnValue(true),
    sync: vi.fn().mockResolvedValue(claim),
    bulkInfo: vi.fn().mockResolvedValue([claim]),
    calculate: vi.fn(),
    book: vi.fn(),
  } as unknown as YandexService;
}

function claim(
  providerStatus: string,
  overrides: Partial<YandexClaimInfo> = {},
): YandexClaimInfo {
  return {
    claimId: '741cedf82cd464fa6fa16d87155c636',
    providerStatus,
    providerUpdatedAt: '2026-09-01T10:00:00Z',
    price: 43_700,
    currency: 'RUB',
    etaMinutes: 25,
    trackingUrl: 'https://yandex.example/track',
    courierName: 'Иван',
    ...overrides,
  };
}

function syncSetup(
  currentStatus: DeliveryStatus,
  orderStatus: OrderStatus,
  yandexClaim: YandexClaimInfo,
  providerUpdatedAt: Date | null = null,
) {
  const current = {
    id: 20,
    status: currentStatus,
    providerUpdatedAt,
    trackingUrl: null,
    courierName: null,
    price: 40_000,
    order: {
      id: 1,
      status: orderStatus,
      subtotal: 300_000,
      finalSubtotal: 284_000,
    },
  };
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 20 }]),
    delivery: {
      findUnique: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockImplementation(({ data }) => ({
        id: 20,
        ...data,
      })),
    },
    order: {
      update: vi.fn().mockImplementation(({ data }) => ({ id: 1, ...data })),
    },
  };
  const findMany = vi.fn().mockResolvedValue([]);
  const db = {
    delivery: {
      findMany,
      findUnique: vi.fn().mockResolvedValue({
        id: 20,
        provider: 'YANDEX',
        externalOrderId: yandexClaim.claimId,
      }),
    },
    $transaction: vi.fn(
      (callback: (value: typeof client) => Promise<unknown>) =>
        callback(client),
    ),
  } as unknown as DbService;
  const yandex = yandexMock(yandexClaim);

  return {
    client,
    findMany,
    yandex,
    service: new DeliveryService(db, yandex),
  };
}

describe('DeliveryService Yandex sync', () => {
  it('keeps READY when a courier is assigned', async () => {
    const { client, service } = syncSetup(
      'PENDING',
      'READY',
      claim('performer_found'),
    );

    await service.syncYandexDelivery(20);

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ASSIGNED' }),
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'READY' }),
      }),
    );
  });

  it('maps pickuped to PICKED_UP and DELIVERING', async () => {
    const { client, service } = syncSetup(
      'ASSIGNED',
      'READY',
      claim('pickuped'),
    );

    await service.syncYandexDelivery(20);

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PICKED_UP' }),
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DELIVERING',
          deliveryPrice: 43_700,
          finalTotal: 327_700,
        }),
      }),
    );
  });

  it.each(['delivered', 'delivered_finish'])(
    'maps %s to DELIVERED and COMPLETED',
    async (providerStatus) => {
      const { client, service } = syncSetup(
        'PICKED_UP',
        'DELIVERING',
        claim(providerStatus),
      );

      await service.syncYandexDelivery(20);

      expect(client.delivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DELIVERED' }),
        }),
      );
      expect(client.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    },
  );

  it('is idempotent and does not roll PICKED_UP back to ASSIGNED', async () => {
    const { client, service } = syncSetup(
      'PICKED_UP',
      'DELIVERING',
      claim('performer_found'),
    );

    await service.syncYandexDelivery(20);

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PICKED_UP' }),
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DELIVERING' }),
      }),
    );
  });

  it('applies a duplicate provider response idempotently', async () => {
    const { client, service } = syncSetup(
      'PICKED_UP',
      'DELIVERING',
      claim('pickuped'),
      new Date('2026-09-01T10:00:00Z'),
    );

    await service.syncYandexDelivery(20);
    await service.syncYandexDelivery(20);

    expect(client.delivery.update).toHaveBeenCalledTimes(2);
    expect(client.delivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PICKED_UP' }),
      }),
    );
    expect(client.order.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DELIVERING' }),
      }),
    );
  });

  it('ignores an older provider state', async () => {
    const { client, service } = syncSetup(
      'PICKED_UP',
      'DELIVERING',
      claim('performer_found', {
        providerUpdatedAt: '2026-09-01T09:59:00Z',
      }),
      new Date('2026-09-01T10:00:00Z'),
    );

    const result = await service.syncYandexDelivery(20);

    expect(result.stale).toBe(true);
    expect(client.delivery.update).not.toHaveBeenCalled();
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it.each(['failed', 'performer_not_found', 'returning'])(
    'does not complete an order for %s',
    async (providerStatus) => {
      const { client, service } = syncSetup(
        'ASSIGNED',
        'READY',
        claim(providerStatus),
      );

      await service.syncYandexDelivery(20);

      expect(client.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    },
  );

  it('does not call Yandex for OTHER deliveries', async () => {
    const yandex = yandexMock(claim('accepted'));
    const db = {
      delivery: {
        findUnique: vi.fn().mockResolvedValue({
          id: 20,
          provider: 'OTHER',
          externalOrderId: 'manual-1',
        }),
      },
    } as unknown as DbService;
    const service = new DeliveryService(db, yandex);

    await expect(service.syncYandexDelivery(20)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(yandex.sync).not.toHaveBeenCalled();
  });
});

describe('DeliveryService Yandex polling', () => {
  it('requests bulk info only for active YANDEX and excludes OTHER/terminal deliveries', async () => {
    const yandexClaim = claim('pickuped');
    const { client, findMany, service, yandex } = syncSetup(
      'ASSIGNED',
      'READY',
      yandexClaim,
    );
    findMany.mockResolvedValue([
      { id: 20, externalOrderId: yandexClaim.claimId },
    ]);

    await service.syncActiveYandexDeliveries();

    expect(findMany).toHaveBeenCalledWith({
      where: {
        provider: 'YANDEX',
        externalOrderId: { not: null },
        status: { in: ['PENDING', 'ASSIGNED', 'PICKED_UP'] },
      },
      select: { id: true, externalOrderId: true },
    });
    expect(yandex.bulkInfo).toHaveBeenCalledWith([yandexClaim.claimId]);
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DELIVERING' }),
      }),
    );
  });

  it('automatically completes an order from delivered_finish', async () => {
    const yandexClaim = claim('delivered_finish', { price: 44_000 });
    const { client, findMany, service, yandex } = syncSetup(
      'PICKED_UP',
      'DELIVERING',
      yandexClaim,
    );
    findMany.mockResolvedValue([
      { id: 20, externalOrderId: yandexClaim.claimId },
    ]);
    vi.mocked(yandex.bulkInfo).mockResolvedValue([yandexClaim]);

    await service.syncActiveYandexDeliveries();

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DELIVERED', price: 44_000 }),
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPLETED',
          deliveryPrice: 44_000,
          finalTotal: 328_000,
        }),
      }),
    );
  });

  it('keeps the accepted offer price when final_price is absent', async () => {
    const yandexClaim = claim('delivered_finish', { price: null });
    const { client, findMany, service, yandex } = syncSetup(
      'PICKED_UP',
      'DELIVERING',
      yandexClaim,
    );
    findMany.mockResolvedValue([
      { id: 20, externalOrderId: yandexClaim.claimId },
    ]);
    vi.mocked(yandex.bulkInfo).mockResolvedValue([yandexClaim]);

    await service.syncActiveYandexDeliveries();

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DELIVERED', price: 40_000 }),
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryPrice: 40_000,
          finalTotal: 324_000,
        }),
      }),
    );
  });

  it('does not change local state when the bulk API fails', async () => {
    const yandexClaim = claim('delivered_finish');
    const { client, findMany, service, yandex } = syncSetup(
      'PICKED_UP',
      'DELIVERING',
      yandexClaim,
    );
    findMany.mockResolvedValue([
      { id: 20, externalOrderId: yandexClaim.claimId },
    ]);
    vi.mocked(yandex.bulkInfo).mockRejectedValue(new Error('429'));

    await expect(service.syncActiveYandexDeliveries()).resolves.toBeUndefined();

    expect(client.delivery.update).not.toHaveBeenCalled();
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('does nothing without a Yandex token', async () => {
    const { findMany, service, yandex } = syncSetup(
      'ASSIGNED',
      'READY',
      claim('accepted'),
    );
    vi.mocked(yandex.isSyncAvailable).mockReturnValue(false);

    await expect(service.syncActiveYandexDeliveries()).resolves.toBeUndefined();

    expect(findMany).not.toHaveBeenCalled();
    expect(yandex.bulkInfo).not.toHaveBeenCalled();
  });

  it('does not overlap polling runs', async () => {
    const { findMany, service } = syncSetup(
      'ASSIGNED',
      'READY',
      claim('accepted'),
    );
    let release: ((value: []) => void) | undefined;
    findMany.mockReturnValue(
      new Promise<[]>((resolve) => {
        release = resolve;
      }),
    );

    const first = service.syncActiveYandexDeliveries();
    await service.syncActiveYandexDeliveries();

    expect(findMany).toHaveBeenCalledTimes(1);
    release?.([]);
    await first;
  });

  it('batches more than 1000 active claims', async () => {
    const { findMany, service, yandex } = syncSetup(
      'ASSIGNED',
      'READY',
      claim('accepted'),
    );
    findMany.mockResolvedValue(
      Array.from({ length: 1_001 }, (_, index) => ({
        id: index + 1,
        externalOrderId: String(index).padStart(32, '0'),
      })),
    );
    vi.mocked(yandex.bulkInfo).mockResolvedValue([]);

    await service.syncActiveYandexDeliveries();

    expect(yandex.bulkInfo).toHaveBeenCalledTimes(2);
    expect(vi.mocked(yandex.bulkInfo).mock.calls[0]?.[0]).toHaveLength(1_000);
    expect(vi.mocked(yandex.bulkInfo).mock.calls[1]?.[0]).toHaveLength(1);
  });
});

describe('DeliveryService Yandex booking', () => {
  it('stores the accepted Yandex price and recalculates finalTotal on backend', async () => {
    const bookingClaim = claim('accepted', { price: 44_125 });
    const yandex = yandexMock(bookingClaim);
    vi.mocked(yandex.book).mockResolvedValue({
      quote: {
        price: 43_700,
        currency: 'RUB',
        pickupFrom: '2026-09-01T10:00:00Z',
        pickupTo: '2026-09-01T10:15:00Z',
        deliveryFrom: '2026-09-01T10:15:00Z',
        deliveryTo: '2026-09-01T10:40:00Z',
        expiresAt: null,
      },
      claim: bookingClaim,
    });
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 1 }]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          type: 'DELIVERY',
          status: 'READY',
          subtotal: 300_000,
          finalSubtotal: 284_000,
          delivery: null,
        }),
        update: vi.fn().mockImplementation(({ data }) => ({ id: 1, ...data })),
      },
      delivery: {
        upsert: vi
          .fn()
          .mockImplementation(({ create }) => ({ id: 20, ...create })),
      },
    };
    const db = {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 1,
          publicId: '123e4567-e89b-12d3-a456-426614174000',
          type: 'DELIVERY',
          status: 'READY',
          customerName: 'Максим',
          customerPhone: '+79050000000',
          city: 'Москва',
          street: 'Пинский проезд',
          house: '7',
          flat: null,
          entrance: null,
          floor: null,
          intercom: null,
          comment: null,
          delivery: null,
          items: [
            {
              id: 10,
              productName: 'Яблоки',
              unit: 'GRAM',
              status: 'PICKED',
              actualQty: 1_063,
              actualTotal: 47_835,
            },
          ],
        }),
      },
      $transaction: vi.fn(
        (callback: (value: typeof client) => Promise<unknown>) =>
          callback(client),
      ),
    } as unknown as DbService;

    await new DeliveryService(db, yandex).order(1);

    expect(client.delivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ price: 44_125 }),
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryPrice: 44_125,
          finalTotal: 328_125,
        }),
      }),
    );
  });
});
