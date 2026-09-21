import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { OrderService } from '../order/order.service.js';
import { orderSchema } from '../order/schema.js';
import { TelegramService } from './telegram.service.js';
import type { TelegramOrder } from './message.js';

const order: TelegramOrder = {
  id: 154, type: 'PICKUP', customerName: 'Private customer', customerPhone: '+70000000000',
  city: null, street: null, house: null, flat: null, entrance: null,
  floor: null, intercom: null, comment: null, deliveryAt: null,
  subtotal: 12345, deliveryPrice: 0, total: 12345,
  items: [{ productName: '<b>Product</b> & *_[]', qty: 1, unit: 'PIECE', total: 12345 }],
};
const input = orderSchema.parse({
  type: 'PICKUP', customerName: 'Customer', customerPhone: '+79991234567',
  items: [{ productId: 1, qty: 1 }],
});
const fetcher = vi.fn<typeof fetch>();
let token: string;

function database() {
  return {
    order: {
      findUnique: vi.fn().mockResolvedValue(order),
      create: vi.fn().mockResolvedValue({ id: order.id }),
    },
    product: { findMany: vi.fn().mockResolvedValue([{
      id: 1, name: 'Product', slug: 'product', price: 12345, priceQty: 1,
      unit: 'PIECE', min: 1, step: 1, portionQty: 1, images: [],
    }]) },
    shopSettings: { findUniqueOrThrow: vi.fn().mockResolvedValue({
      weightToleranceBps: 1000, minDeliverySubtotal: 0, deliveryEnabled: true, pickupEnabled: true,
    }) },
    guestSession: { create: vi.fn().mockResolvedValue({ id: 'guest' }) },
  };
}

beforeEach(() => {
  token = randomUUID(); // Ephemeral test value, never a real bot credential.
  vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
  vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', '123,456');
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('TelegramService', () => {
  it.each([
    ['TELEGRAM_BOT_TOKEN', ''], ['TELEGRAM_ADMIN_CHAT_IDS', ' , '],
    ['TELEGRAM_ADMIN_CHAT_IDS', '0,abc,1.5,9007199254740992'],
  ])('is disabled for missing/invalid configuration %s', async (key, value) => {
    vi.stubEnv(key, value);
    const db = database();
    const service = new TelegramService(db as unknown as DbService);
    expect(service.available).toBe(false);
    await service.notifyNewOrder(154);
    expect(db.order.findUnique).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalizes, validates and deduplicates recipients and sends plain text with staff link', async () => {
    vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', ' 123, ,00123,-100123,456,abc,1.5,0,1e3, ');
    await new TelegramService(database() as unknown as DbService).notifyNewOrder(154);
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies.map(body => body.chat_id)).toEqual(['123', '-100123', '456']);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url).endsWith('/sendMessage')).toBe(true);
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(options?.body));
      expect(body).not.toHaveProperty('parse_mode');
      expect(body.text).toContain('<b>Product</b> & *_[]');
      expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
        text: 'Открыть заказ', url: 'https://shop.example/staff/orders/154',
      });
    }
  });

  it.each(['reject', 'http', 'api', 'json', 'timeout'])('isolates one recipient failure (%s) without leaking errors', async kind => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    if (kind === 'reject') fetcher.mockRejectedValueOnce(new Error('secret ' + token + ' ' + order.customerPhone));
    if (kind === 'http') fetcher.mockResolvedValueOnce(new Response(token, { status: 500 }));
    if (kind === 'api') fetcher.mockResolvedValueOnce(Response.json({ ok: false, description: token }));
    if (kind === 'json') fetcher.mockResolvedValueOnce(new Response('bad JSON ' + token));
    if (kind === 'timeout') fetcher.mockRejectedValueOnce(new DOMException('secret ' + token, 'TimeoutError'));
    await expect(new TelegramService(database() as unknown as DbService).notifyNewOrder(154)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(7000);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Telegram notification failed for order 154');
  });

  it('swallows database errors and skips missing orders', async () => {
    const db = database();
    db.order.findUnique.mockRejectedValueOnce(new Error(token));
    const service = new TelegramService(db as unknown as DbService);
    await expect(service.notifyNewOrder(154)).resolves.toBeUndefined();
    db.order.findUnique.mockResolvedValueOnce(null);
    await service.notifyNewOrder(155);
    expect(fetcher).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Telegram notification failed for order 154');
  });

  it.each(['', 'http://shop.example', 'https://user:password@shop.example'])('omits unsafe/missing staff link (%s)', async origin => {
    vi.stubEnv('ORDER_SITE_URL', origin);
    await new TelegramService(database() as unknown as DbService).notifyNewOrder(154);
    for (const [, options] of fetcher.mock.calls)
      expect(JSON.parse(String(options?.body))).not.toHaveProperty('reply_markup');
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Telegram staff link unavailable: check ORDER_SITE_URL');
  });
});

describe('Order creation side effect', () => {
  it('creates a guest order with Telegram disabled and does not access the network', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const db = database();
    const typed = db as unknown as DbService;
    const result = await new OrderService(typed, new TelegramService(typed)).create(null, undefined, input);
    expect(result.order.id).toBe(154);
    expect(result.guestToken).toEqual(expect.any(String));
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.order.findUnique).not.toHaveBeenCalled();
  });

  it('dispatches only after the order write resolves; never when that write fails', async () => {
    const db = database();
    let resolveWrite!: (value: { id: number }) => void;
    db.order.create.mockImplementationOnce(() => new Promise(resolve => { resolveWrite = resolve; }));
    const typed = db as unknown as DbService;
    const telegram = new TelegramService(typed);
    const notify = vi.spyOn(telegram, 'notifyNewOrder');
    const service = new OrderService(typed, telegram);
    const pending = service.create(42, undefined, input);
    await vi.waitFor(() => expect(db.order.create).toHaveBeenCalled());
    expect(notify).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    resolveWrite({ id: 154 });
    await pending;
    expect(notify).toHaveBeenCalledExactlyOnceWith(154);
    await notify.mock.results[0]!.value;
    notify.mockClear();
    db.order.create.mockRejectedValueOnce(new Error('DB write failed'));
    await expect(service.create(42, undefined, input)).rejects.toThrow('DB write failed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('returns the order while Telegram is still waiting for a network response', async () => {
    const db = database();
    const typed = db as unknown as DbService;
    let finish!: () => void;
    const pending = new Promise<Response>(resolve => {
      finish = () => resolve(Response.json({ ok: true }));
    });
    vi.stubEnv('TELEGRAM_ADMIN_CHAT_IDS', '123');
    fetcher.mockReturnValueOnce(pending);
    const telegram = new TelegramService(typed);
    const notify = vi.spyOn(telegram, 'notifyNewOrder');
    try {
      const result = await new OrderService(typed, telegram).create(42, undefined, input);
      expect(result.order.id).toBe(154);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      finish();
    }
    await notify.mock.results[0]!.value;
  });

  it.each(['reject', 'http'])('keeps checkout successful when Telegram fails (%s)', async kind => {
    if (kind === 'reject') fetcher.mockRejectedValue(new Error(token));
    else fetcher.mockImplementation(async () => new Response(token, { status: 500 }));
    const db = database();
    const typed = db as unknown as DbService;
    const telegram = new TelegramService(typed);
    const notify = vi.spyOn(telegram, 'notifyNewOrder');
    await expect(new OrderService(typed, telegram).create(42, undefined, input))
      .resolves.toMatchObject({ order: { id: 154 } });
    await expect(notify.mock.results[0]!.value).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Telegram notification failed for order 154');
  });
});
