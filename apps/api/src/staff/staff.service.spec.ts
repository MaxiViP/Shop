import { BadRequestException } from '@nestjs/common';
import type {
  DeliveryProvider,
  DeliveryStatus,
  OrderStatus,
  OrderType,
} from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { StaffService } from './staff.service.js';
import { NotificationService } from '../order/notification.service.js';

interface LockedDelivery {
  id: number;
  provider: DeliveryProvider;
  status: DeliveryStatus;
  trackingUrl: string | null;
  courierName: string | null;
  courierPhone: string | null;
  externalOrderId: string | null;
  price: number | null;
}

interface LockedOrder {
  payment?: { status: string; amount: number } | null;
  id: number;
  type: OrderType;
  status: OrderStatus;
  deliveryPrice: number | null;
  subtotal: number;
  finalSubtotal: number | null;
  delivery: LockedDelivery | null;
}

function setup(order: LockedOrder) {
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: order.id, role: 'SELLER' }]),

    order: {
      findUniqueOrThrow: vi.fn(async () => client.order.findUnique()),
      findUnique: vi.fn().mockResolvedValue({
        weightToleranceBps: 1000,
        assemblyFinalizedAt: ['READY', 'DELIVERING', 'COMPLETED'].includes(
          order.status,
        )
          ? new Date()
          : null,
        payment: ['READY', 'DELIVERING', 'COMPLETED'].includes(order.status)
          ? { status: 'PAID', amount: order.finalSubtotal }
          : null,
        ...order,
      }),
      update: vi.fn().mockResolvedValue({ id: order.id }),
    },

    orderItem: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: 10,
            productName: 'Товар',
            unit: 'PIECE',
            qty: 1,
            actualQty: 1,
            price: 12_300,
            priceQty: 1,
            status: 'PICKED',
          },
        ]),
      findFirst: vi.fn(),
      update: vi.fn(async ({ data }: { data: object }) => ({ id: 10, orderId: order.id, productName: 'Товар', productSlug: 'item', unit: 'PIECE', qty: 1, actualQty: 1, price: 100, priceQty: 1, status: 'PICKED', ...data })),
    },

    delivery: {
      update: vi.fn().mockResolvedValue({ id: 20 }),
      upsert: vi.fn().mockResolvedValue({ id: 20 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 20, orderId: 1 }),
    },
    deliveryAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
    orderPayment: { upsert: vi.fn().mockResolvedValue({ id: 1, updatedAt: new Date() }),
      updateMany: vi.fn(), update: vi.fn().mockResolvedValue({ status: 'PAID' }) },
    orderExtra: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 30 }), update: vi.fn().mockResolvedValue({ id: 30 }) },
    shopSettings: { findUniqueOrThrow: vi.fn().mockResolvedValue({
      maxOrderExtraUnitPrice: 1000000, maxOrderExtrasTotal: 1000000,
    }) },
    orderStaffAudit: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    orderIssue: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({ id: 1, orderId: order.id, version: 1 }), updateMany: vi.fn() },
    orderNotification: { create: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    orderChatMessage: { create: vi.fn() },
    orderCancellation: { create: vi.fn() },
  };

  const db = {
    $transaction: vi.fn(
      (callback: (value: typeof client) => Promise<unknown>) =>
        callback(client),
    ),
  } as unknown as DbService;

  return {
    client,
    service: new StaffService(db, { dispatch: vi.fn() } as unknown as NotificationService),
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
  it.each([1100, 1101, 2000])('finalize validates saved GRAM weight %i before any writes', async (actualQty) => {
    const { client, service } = setup({ ...assembling, finalSubtotal: null });
    client.orderItem.findMany.mockResolvedValue([
      { id: 10, productName: 'Томаты', unit: 'GRAM', qty: 1000, actualQty,
        price: 100000, priceQty: 1000, status: 'PICKED' },
    ]);
    if (actualQty === 1100) {
      await service.finishAssembly(1);
      expect(client.orderPayment.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: { orderId: 1, amount: 110000 },
      }));
    } else {
      await expect(service.finishAssembly(1)).rejects.toMatchObject({
        status: 409,
        response: { code: 'WEIGHT_CONFIRMATION_REQUIRED', itemIds: [10] },
      });
      expect(client.orderItem.update).not.toHaveBeenCalled();
      expect(client.order.update).not.toHaveBeenCalled();
      expect(client.orderPayment.upsert).not.toHaveBeenCalled();
    }
  });

  it.each([
    { type: 'PICKUP', deliveryPrice: 0, finalTotal: 12_300 },
    { type: 'DELIVERY', deliveryPrice: null, finalTotal: null },
    { type: 'DELIVERY', deliveryPrice: 45_000, finalTotal: 57_300 },
  ] as const)(
    'finishes $type assembly with price $deliveryPrice',
    async ({ type, deliveryPrice, finalTotal }) => {
      const { client, service } = setup({
        ...assembling,
        type,
        deliveryPrice,
        finalSubtotal: null,
      });
      await service.finishAssembly(1);
      expect(client.order.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          status: 'READY',
          finalSubtotal: 12_300,
          finalTotal,
          assemblyFinalizedAt: expect.any(Date),
        },
      });
    },
  );

  it.each([null, 0, -1, 1.5, NaN])(
    'rejects OTHER handoff with price %s',
    async (price) => {
      const { client, service } = setup({
        ...assembling,
        status: 'READY',
        delivery: {
          id: 20,
          provider: 'OTHER',
          status: 'ASSIGNED',
          price,
          courierName: 'Иван',
          courierPhone: '+79991234567',
          trackingUrl: null,
          externalOrderId: null,
        },
      });
      await expect(service.handoff(1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(client.delivery.update).not.toHaveBeenCalled();
      expect(client.order.update).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, -1, 1.5, NaN])(
    'rejects saving OTHER with price %s',
    async (price) => {
      const { client, service } = setup({ ...assembling, status: 'READY' });
      await expect(
        service.delivery(1, {
          provider: 'OTHER',
          courierName: 'Иван',
          courierPhone: '+79991234567',
          price,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.delivery.upsert).not.toHaveBeenCalled();
    },
  );

  it('fills unknown totals after assembly and revises manual delivery price', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'READY',
      deliveryPrice: null,
    });
    for (const price of [45_000, 48_700]) {
      await service.delivery(1, {
        provider: 'OTHER',
        courierName: 'Иван',
        courierPhone: '+79991234567',
        price,
      });
      expect(client.delivery.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ price }),
          update: expect.objectContaining({ price }),
        }),
      );
      expect(client.order.update).toHaveBeenLastCalledWith({
        where: { id: 1 },
        data: {
          deliveryPrice: price,
          total: 10_000 + price,
          finalTotal: 9_500 + price,
        },
      });
    }
  });

  it('cannot replace a booked Yandex claim with OTHER', async () => {
    const { client, service } = setup({
      ...assembling,
      status: 'READY',
      delivery: {
        id: 20,
        provider: 'YANDEX',
        status: 'ASSIGNED',
        price: 45_000,
        courierName: null,
        courierPhone: null,
        trackingUrl: null,
        externalOrderId: 'claim-id',
      },
    });
    await expect(
      service.delivery(1, {
        provider: 'OTHER',
        price: 45_000,
        courierName: 'Иван',
        courierPhone: '+79991234567',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.delivery.upsert).not.toHaveBeenCalled();
  });

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
    client.orderItem.findMany.mockResolvedValue([
      { id: 10, status: 'PENDING' },
    ]);

    await expect(service.finishAssembly(1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('does not finish assembly with pending items', async () => {
    const { client, service } = setup(assembling);

    client.orderItem.findMany.mockResolvedValue([
      { id: 10, status: 'PENDING' },
    ]);

    await expect(service.finishAssembly(1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.order.update).not.toHaveBeenCalled();
  });

  it('calculates final totals when assembly is finished', async () => {
    const { client, service } = setup(assembling);


    await service.finishAssembly(1);

    expect(client.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'READY',
          finalSubtotal: 12_300,
          finalTotal: 12_800,
          assemblyFinalizedAt: expect.any(Date),
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
        price: 500,
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
        data: {
          status: 'DELIVERING',
          deliveryPrice: 500,
          total: 10_500,
          finalTotal: 10_000,
        },
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
        price: 500,
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
        price: 500,
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

  it('rejects cancellation of an externally assigned OTHER delivery', async () => {
    const { client, service } = setup({
      ...assembling,
      payment: { status: 'AWAITING', amount: 9500 },
      status: 'READY',
      delivery: {
        id: 20,
        provider: 'OTHER',
        status: 'ASSIGNED',
        price: 500,
        trackingUrl: null,
        courierName: 'Александр',
        courierPhone: '+79990000000',
        externalOrderId: null,
      },
    });

    await expect(service.cancel(1)).rejects.toThrow('внешнюю доставку');
    expect(client.delivery.update).not.toHaveBeenCalled();
    expect(client.order.update).not.toHaveBeenCalled();
    expect(client.orderCancellation.create).not.toHaveBeenCalled();
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

const seller = { userId: 7, role: 'SELLER' } as const;
const admin = { userId: 7, role: 'ADMIN' } as const;
function audited(client: ReturnType<typeof setup>['client'], action: string,
  entityType?: string, entityId?: number) {
  expect(client.orderStaffAudit.create).toHaveBeenCalledExactlyOnceWith({
    data: { orderId: 1, userId: 7, role: 'SELLER', action, entityType, entityId },
  });
}

describe('StaffService durable actor audit', () => {
  it.each([
    { status: 'NEW', action: 'CONFIRM', run: (s: StaffService) => s.confirm(1, seller) },
    { status: 'CONFIRMED', action: 'START_ASSEMBLY', run: (s: StaffService) => s.startAssembly(1, seller) },
    { status: 'READY', action: 'PICKUP_COMPLETE', run: (s: StaffService) => s.completePickup(1, seller) },
  ] as const)('$action records the linked User and role in the mutation transaction', async row => {
    const { client, service } = setup({ ...assembling, type: 'PICKUP', status: row.status });
    await row.run(service);
    audited(client, row.action);
  });

  it.each([
    { status: 'PICKED', input: { status: 'PICKED' as const, actualQty: 742 }, action: 'ITEM_PICKED', before: 'PENDING' },
    { status: 'MISSING', input: { status: 'MISSING' as const }, action: 'ITEM_MISSING', before: 'PENDING' },
    { status: 'PENDING', input: { status: 'PENDING' as const }, action: 'ITEM_RESET', before: 'PICKED' },
  ])('$action records the item without changing snapshot price', async row => {
    const { client, service } = setup(assembling);
    client.orderItem.findFirst.mockResolvedValue({
      id: 10, orderId: 1, price: 45000, priceQty: 1000,
      status: row.before, actualQty: row.before === 'PICKED' ? 700 : null,
    });
    await service.item(1, 10, row.input, 7, seller);
    audited(client, row.action, 'ITEM', 10);
    const updated = client.orderItem.update.mock.calls[0]?.[0];
    expect(updated?.data).not.toHaveProperty('price');
  });

  it('audits finish and reopen only after domain checks succeed', async () => {
    const finish = setup(assembling);
    await finish.service.finishAssembly(1, seller);
    audited(finish.client, 'FINISH_ASSEMBLY');
    const reopen = setup({ ...assembling, status: 'READY',
      payment: { status: 'AWAITING', amount: 9500 } });
    await reopen.service.reopen(1, seller);
    audited(reopen.client, 'REOPEN');
    const denied = setup(assembling);
    denied.client.orderItem.findMany.mockResolvedValue([{ id: 10, status: 'PENDING' }]);
    await expect(denied.service.finishAssembly(1, seller)).rejects.toThrow();
    expect(denied.client.orderStaffAudit.create).not.toHaveBeenCalled();
  });

  it('audits payment once and preserves the confirmedBy User', async () => {
    const { client, service } = setup({ ...assembling, status: 'READY',
      payment: { status: 'AWAITING', amount: 9500 } });
    await service.confirmPayment(1, 7, undefined, seller);
    audited(client, 'PAYMENT_CONFIRM');
    expect(client.orderPayment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ confirmedById: 7 }),
    }));
  });

  it.each([
    { mode: 'add', action: 'EXTRA_ADD' },
    { mode: 'edit', action: 'EXTRA_EDIT' },
    { mode: 'cancel', action: 'EXTRA_CANCEL' },
  ])('$action audits the active extra', async row => {
    const { client, service } = setup(assembling);
    if (row.mode !== 'add') client.orderExtra.findFirst.mockResolvedValue({
      id: 30, orderId: 1, status: 'ACTIVE', version: 1, title: 'Old',
      comment: null, quantity: 1, unitPrice: 100, amount: 100,
    });
    const data = row.mode === 'cancel' ? null :
      { title: 'New', comment: '', quantity: 2, unitPrice: 200 };
    await service.extra(1, 7, data, row.mode === 'add' ? undefined : 30,
      row.mode === 'add' ? undefined : 1, seller);
    audited(client, row.action, 'EXTRA', 30);
  });

  it('audits cancellation and keeps the domain cancellation actor', async () => {
    const { client, service } = setup({ ...assembling, status: 'NEW' });
    await service.cancel(1, 7, 'SELLER', 'No stock', seller);
    audited(client, 'CANCEL');
    expect(client.orderCancellation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ canceledById: 7, canceledByRole: 'SELLER' }),
    }));
  });

  it('audits OTHER delivery update, handoff and completion', async () => {
    const update = setup({ ...assembling, status: 'READY' });
    await update.service.delivery(1, { provider: 'OTHER', courierName: 'Courier',
      courierPhone: '+79990000000', price: 500 }, seller);
    audited(update.client, 'DELIVERY_UPDATE', 'DELIVERY', 20);
    const assigned = { id: 20, provider: 'OTHER' as const, status: 'ASSIGNED' as const,
      price: 500, trackingUrl: null, courierName: 'Courier',
      courierPhone: '+79990000000', externalOrderId: null };
    const handoff = setup({ ...assembling, status: 'READY', delivery: assigned });
    await handoff.service.handoff(1, seller);
    audited(handoff.client, 'DELIVERY_HANDOFF', 'DELIVERY', 20);
    const complete = setup({ ...assembling, status: 'DELIVERING',
      delivery: { ...assigned, status: 'PICKED_UP' } });
    await complete.service.completeDelivery(1, seller);
    audited(complete.client, 'DELIVERY_COMPLETE', 'DELIVERY', 20);
  });

  it('does not audit a repeated identical OTHER delivery update', async () => {
    const delivery = { id: 20, provider: 'OTHER' as const, status: 'ASSIGNED' as const,
      price: 500, trackingUrl: null, courierName: 'Courier',
      courierPhone: '+79990000000', externalOrderId: null };
    const { client, service } = setup({ ...assembling, status: 'READY', delivery });
    const saved = await service.delivery(1, { provider: 'OTHER', courierName: 'Courier',
      courierPhone: '+79990000000', price: 500 }, seller);
    expect(saved).toEqual({ id: 20, orderId: 1 });
    expect(client.delivery.upsert).not.toHaveBeenCalled();
    expect(client.orderStaffAudit.create).not.toHaveBeenCalled();
  });

  it('does not audit duplicate, invalid or revoked actions', async () => {
    const duplicate = setup({ ...assembling, status: 'CONFIRMED' });
    await duplicate.service.confirm(1, seller);
    expect(duplicate.client.orderStaffAudit.create).not.toHaveBeenCalled();
    const invalid = setup(assembling);
    await expect(invalid.service.startAssembly(1, seller)).rejects.toThrow();
    expect(invalid.client.orderStaffAudit.create).not.toHaveBeenCalled();
    const revoked = setup({ ...assembling, status: 'NEW' });
    revoked.client.$queryRaw.mockResolvedValue([{ id: 1, role: 'USER' }]);
    await expect(revoked.service.confirm(1, seller)).rejects.toThrow();
    expect(revoked.client.orderStaffAudit.create).not.toHaveBeenCalled();
  });


  it('skips audit for repeated item, payment, cancellation and extra no-ops', async () => {
    const item = setup(assembling);
    item.client.orderItem.findFirst.mockResolvedValue({
      id: 10, orderId: 1, status: 'PICKED', actualQty: 700,
      price: 45000, priceQty: 1000,
    });
    await item.service.item(1, 10, { status: 'PICKED', actualQty: 700 }, 7, seller);
    expect(item.client.orderStaffAudit.create).not.toHaveBeenCalled();

    const paid = setup({ ...assembling, status: 'READY' });
    await paid.service.confirmPayment(1, 7, undefined, seller);
    expect(paid.client.orderStaffAudit.create).not.toHaveBeenCalled();

    const canceled = setup({ ...assembling, status: 'CANCELED' });
    await canceled.service.cancel(1, 7, 'SELLER', 'reason', seller);
    expect(canceled.client.orderStaffAudit.create).not.toHaveBeenCalled();

    const extra = setup(assembling);
    extra.client.orderExtra.findFirst.mockResolvedValue({
      id: 30, orderId: 1, status: 'ACTIVE', version: 1, title: 'Same',
      comment: null, quantity: 1, unitPrice: 100, amount: 100,
    });
    await extra.service.extra(1, 7, { title: 'Same', comment: '',
      quantity: 1, unitPrice: 100 }, 30, 1, seller);
    expect(extra.client.orderExtra.update).not.toHaveBeenCalled();
    expect(extra.client.orderStaffAudit.create).not.toHaveBeenCalled();
  });

  it('rejects mismatched domain userId and actor before any write', async () => {
    const { client, service } = setup(assembling);
    await expect(service.extra(1, 99, { title: 'Test', quantity: 1,
      unitPrice: 100 }, undefined, undefined, seller)).rejects.toThrow();
    expect(client.orderExtra.create).not.toHaveBeenCalled();
    expect(client.orderStaffAudit.create).not.toHaveBeenCalled();
  });
  it('records ADMIN from current DB role, not a Telegram supplied value', async () => {
    const { client, service } = setup({ ...assembling, status: 'NEW' });
    client.$queryRaw.mockResolvedValue([{ id: 1, role: 'ADMIN' }]);
    await service.confirm(1, admin);
    expect(client.orderStaffAudit.create).toHaveBeenCalledWith({
      data: { orderId: 1, userId: 7, role: 'ADMIN', action: 'CONFIRM',
        entityType: undefined, entityId: undefined },
    });
  });
});
