import { NotificationService } from './notification.service.js';
import type { DbService } from '../db/db.service.js';
import type { CustomerNotificationService } from '../telegram/customer-notification.service.js';

function setup() {
  const db = {
    orderNotification: { findMany: vi.fn().mockResolvedValue([]) },
    customerTelegramSession: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const sms = { available: true, send: vi.fn(async () => {}) };
  const telegram = { available: true, send: vi.fn(async () => 'sent' as const) };
  const service = new NotificationService(db as unknown as DbService, sms, telegram as unknown as CustomerNotificationService);
  return { db, sms, telegram, service };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('keeps Telegram delivery outside the domain HTTP dispatch path and preserves SMS selection', async () => {
  const { db, telegram, service } = setup();
  const delivery = vi.spyOn(service, 'dispatchTelegram');
  await service.dispatch(1);
  expect(db.orderNotification.findMany).toHaveBeenCalledExactlyOnceWith({
    where: { orderId: 1, channel: 'SMS', status: 'PENDING' }, orderBy: { id: 'asc' }, take: 50,
  });
  expect(delivery).not.toHaveBeenCalled();
  expect(telegram.send).not.toHaveBeenCalled();
});

it('sweeps only pending Telegram rows, coalesces orders, bounds cleanup and stops its timer', async () => {
  vi.useFakeTimers();
  vi.stubEnv('NODE_ENV', 'production');
  const { db, sms, service } = setup();
  db.orderNotification.findMany.mockResolvedValue([{ orderId: 1 }, { orderId: 1 }, { orderId: 2 }]);
  db.customerTelegramSession.findMany.mockResolvedValue([{ id: 'expired-reservation' }]);
  const delivery = vi.spyOn(service, 'dispatchTelegram').mockResolvedValue(undefined);
  service.onModuleInit();
  try {
    await vi.advanceTimersByTimeAsync(30000);
    expect(db.orderNotification.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { channel: 'TELEGRAM', status: 'PENDING' }, orderBy: { id: 'asc' }, take: 50, select: { orderId: true },
    });
    expect(delivery.mock.calls).toEqual([[1], [2]]);
    expect(sms.send).not.toHaveBeenCalled();
    expect(db.customerTelegramSession.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: expect.any(Date) } }, orderBy: { expiresAt: 'asc' }, take: 100, select: { id: true },
    });
    expect(db.customerTelegramSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['expired-reservation'] }, expiresAt: { lte: expect.any(Date) } },
    });
  } finally { service.onModuleDestroy(); }
  await vi.advanceTimersByTimeAsync(60000);
  expect(delivery).toHaveBeenCalledTimes(2);
});
