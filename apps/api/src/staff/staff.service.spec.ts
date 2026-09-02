import { BadRequestException } from '@nestjs/common';
import type {
  DeliveryProvider,
  DeliveryStatus,
  OrderStatus,
  OrderType,
} from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { StaffService } from './staff.service.js';

interface LockedDelivery {
  id: number;
  provider: DeliveryProvider;
  status: DeliveryStatus;
  trackingUrl: string | null;
  courierName: string | null;
  courierPhone: string | null;
  externalOrderId: string | null;
}

interface LockedOrder {
  id: number;
  type: OrderType;
  status: OrderStatus;
  deliveryPrice: number;
  subtotal: number;
  finalSubtotal: number | null;
  delivery: LockedDelivery | null;
}

function setup(order: LockedOrder) {
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: order.id }]),

    order: {
      findUnique: vi.fn().mockResolvedValue(order),
      update: vi.fn().mockResolvedValue({ id: order.id }),
    },

    orderItem: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 10 }),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({
        _sum: { actualTotal: 0 },
      }),
    },

    delivery: {
      update: vi.fn().mockResolvedValue({ id: 20 }),
      upsert: vi.fn().mockResolvedValue({ id: 20 }),
    },
  };

  const db = {
    $transaction: vi.fn(
      (callback: (value: typeof client) => Promise<unknown>) =>
        callback(client),
    ),
  } as unknown as DbService;

  return {
    client,
    service: new StaffService(db),
  };
}

const assembling: LockedOrder = {
  id: 1,
  type: 'DELIVERY',
  status: 'ASSEMBLING',
  deliveryPrice: 500,
  subtotal: 10_000,
  finalSubtotal: 9_500,
  delivery: null,
};

describe('StaffService', () => {
  it('calculates actualTotal from saved item values', async () => {
    const { client, service } = setup(assembling);

    client.orderItem.findFirst.mockResolvedValue({
      id: 10,
      price: 45_000,
      priceQty: 1_000,
      status: 'PENDING',
    });

    await service.item(1, 10, {
      status: 'PICKED',
      actualQty: 1_063,
    });

    expect(client.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'PICKED',
          actualQty: 1_063,
          actualTotal: 47_835,
        },
      }),
    );
  });

  it('sets missing item quantity and total to zero', async () => {
    const { client, service } = setup(assembling);

    client.orderItem.findFirst.mockResolvedValue({
      id: 10,
      price: 45_000,
      priceQty: 1_000,
      status: 'PENDING',
    });

    await service.item(1, 10, {
      status: 'MISSING',
    });

    expect(client.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'MISSING',
          actualQty: 0,
          actualTotal: 0,
        },
      }),
    );
  });

  it.each(['PICKED', 'MISSING'] as const)(
    'returns a %s item to pending and clears actual values',
    async (status) => {
      const { client, service } = setup(assembling);

      client.orderItem.findFirst.mockResolvedValue({
        id: 10,
        price: 45_000,
        priceQty: 1_000,
        status,
      });

      await service.item(1, 10, { status: 'PENDING' });

      expect(client.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: 'PENDING',
            actualQty: null,
            actualTotal: null,
          },
        }),
      );
    },
  );

  it('rejects returning an item outside assembly', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'READY',
    });

    await expect(
      service.item(1, 10, { status: 'PENDING' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.orderItem.update).not.toHaveBeenCalled();
  });

  it('does not finish assembly after an item is returned to pending', async () => {
    const { client, service } = setup(assembling);

    client.orderItem.findFirst.mockResolvedValue({
      id: 10,
      price: 45_000,
      priceQty: 1_000,
      status: 'MISSING',
    });

    await service.item(1, 10, { status: 'PENDING' });
    client.orderItem.count.mockResolvedValue(1);

    await expect(service.finishAssembly(1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('does not finish assembly with pending items', async () => {
    const { client, service } = setup(assembling);

    client.orderItem.count.mockResolvedValue(1);

    await expect(service.finishAssembly(1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('calculates final totals when assembly is finished', async () => {
    const { client, service } = setup(assembling);

    client.orderItem.aggregate.mockResolvedValue({
      _sum: { actualTotal: 12_300 },
    });

    await service.finishAssembly(1);

    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'READY',
          finalSubtotal: 12_300,
          finalTotal: 12_800,
        },
      }),
    );
  });

  it('hands a delivery order to the courier atomically', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'READY',
      delivery: {
        id: 20,
        provider: 'OTHER',
        status: 'ASSIGNED',
        trackingUrl: null,
        courierName: 'Александр',
        courierPhone: '+79990000000',
        externalOrderId: null,
      },
    });

    await service.handoff(1);

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'PICKED_UP' },
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'DELIVERING' },
      }),
    );
  });

  it('does not allow manual handoff for Yandex delivery', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'READY',
      delivery: {
        id: 20,
        provider: 'YANDEX',
        status: 'ASSIGNED',
        trackingUrl: 'https://yandex.example/track',
        courierName: null,
        courierPhone: null,
        externalOrderId: '741cedf82cd464fa6fa16d87155c636',
      },
    });

    await expect(service.handoff(1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.delivery.update).not.toHaveBeenCalled();
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('completes order and delivery together', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'DELIVERING',
      delivery: {
        id: 20,
        provider: 'OTHER',
        status: 'PICKED_UP',
        trackingUrl: null,
        courierName: 'Александр',
        courierPhone: '+79990000000',
        externalOrderId: null,
      },
    });

    await service.completeDelivery(1);

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'DELIVERED' },
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'COMPLETED' },
      }),
    );
  });

  it('cancels assigned delivery together with the order', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'READY',
      delivery: {
        id: 20,
        provider: 'OTHER',
        status: 'ASSIGNED',
        trackingUrl: null,
        courierName: 'Александр',
        courierPhone: '+79990000000',
        externalOrderId: null,
      },
    });

    await service.cancel(1);

    expect(client.delivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'CANCELED' },
      }),
    );
    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'CANCELED' },
      }),
    );
  });

  it('completes pickup without creating delivery', async () => {
    const { client, service } = setup({
      ...assembling,
      type: 'PICKUP',
      status: 'READY',
    });

    await service.completePickup(1);

    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'COMPLETED' },
      }),
    );
    expect(client.delivery.update).not.toHaveBeenCalled();
    expect(client.delivery.upsert).not.toHaveBeenCalled();
  });
});
