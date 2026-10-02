import type { DbService } from '../db/db.service.js';
import type { CustomerNotificationService } from '../telegram/customer-notification.service.js';
import { NotificationService } from './notification.service.js';

function setup() {
  const states = new Map([[1, 'PENDING'], [2, 'PENDING']]);
  const identities = new Map<number, { id: number; telegramUserId: bigint; botStartedAt: Date; blockedAt: Date | null } | null>([
    [1, { id: 11, telegramUserId: 1001n, botStartedAt: new Date(), blockedAt: null }],
    [2, { id: 12, telegramUserId: 1002n, botStartedAt: new Date(), blockedAt: null }],
  ]);
  const change = { orderId: 21, previousPrice: 10000, newPrice: 10500,
    createdAt: new Date('2026-10-02T08:00:00.000Z'), reason: 'Цена на рынке',
    item: { productName: 'Баклажан', productId: 34 }, actor: { name: 'Иван', role: 'SELLER' } };
  const db = {
    orderNotification: {
      findMany: vi.fn(async () => [...states].filter(([, status]) => status === 'PENDING')
        .map(([id]) => ({ id }))),
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) => ({
        priceChange: change,
        recipientUser: { role: 'ADMIN', staffTelegramIdentity: identities.get(where.id) },
      })),
      updateMany: vi.fn(async ({ where, data }: { where: { id: number; status: string }; data: { status: string } }) => {
        if (states.get(where.id) !== where.status) return { count: 0 };
        states.set(where.id, data.status);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: { status: string } }) => {
        states.set(where.id, data.status);
      }),
    },
    staffTelegramIdentity: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
  };
  const sms = { available: false, send: vi.fn(async () => {}) };
  const customer = { available: false, send: vi.fn(async () => 'sent' as const) };
  const service = new NotificationService(db as unknown as DbService, sms,
    customer as unknown as CustomerNotificationService);
  return { db, states, identities, service };
}

beforeEach(() => {
  vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', 'test-staff-token');
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sends a committed price change to both linked ADMIN identities once', async () => {
  const { service, states, db } = setup();
  await service.dispatchStaffPrice(21);
  await service.dispatchStaffPrice(21);
  expect(states.get(1)).toBe('SENT');
  expect(states.get(2)).toBe('SENT');
  const sent = vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as {
    chat_id: string; text: string;
  });
  expect(sent.map(body => body.chat_id)).toEqual(['1001', '1002']);
  expect(sent[0]?.text).toContain('Цена заказа: 100 ₽');
  expect(sent[0]?.text).toContain('Новая цена: 105 ₽');
  expect(sent[0]?.text).toContain('Изменил: продавец Иван');
  expect(sent[0]?.text).toContain('Разница: +5 ₽ (+5%)');
  expect(sent[0]?.text).toContain('Время:');
  expect(sent[0]?.text).toContain('Причина: Цена на рынке');
  expect(sent[0]?.text).toContain('https://shop.example/staff/orders/21');
  expect(sent[0]?.text).toContain('https://shop.example/admin/products/34');
  expect(db.orderNotification.updateMany).toHaveBeenCalledTimes(2);
});

it('skips an unlinked ADMIN without blocking another recipient', async () => {
  const { service, identities, states } = setup();
  identities.set(1, null);
  await service.dispatchStaffPrice(21);
  expect(states.get(1)).toBe('UNCONFIGURED');
  expect(states.get(2)).toBe('SENT');
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

it('records an uncertain Telegram failure without replaying or changing the committed price', async () => {
  const { service, states } = setup();
  vi.mocked(fetch).mockRejectedValue(new Error('synthetic network failure'));
  await service.dispatchStaffPrice(21);
  await service.dispatchStaffPrice(21);
  expect(states.get(1)).toBe('SENDING');
  expect(states.get(2)).toBe('SENDING');
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
});
