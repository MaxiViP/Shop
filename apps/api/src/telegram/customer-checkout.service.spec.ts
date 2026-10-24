import { ConflictException } from '@nestjs/common';
import type { CustomerTelegramSession } from '../db/gen/client.js';
import type { DbService } from '../db/db.service.js';
import type { CartService } from '../cart/cart.service.js';
import type { OrderService } from '../order/order.service.js';
import { CustomerCheckoutService } from './customer-checkout.service.js';
import { receivingPayload } from './receiving.js';
import { checkoutPayload } from './checkout.js';

const revision = '11111111-1111-4111-8111-111111111111';
const identity = { id: 3, userId: 7 };
const savedAddress = { id: 9, userId: 7, label: 'Дом', isDefault: true, updatedAt: new Date('2026-10-20T09:00:00Z'), city: 'Москва', street: 'Тестовая', house: '1',
  buildingPart: null, flat: '12', entrance: null, floor: null, intercom: null, comment: null };
const slot = '2026-10-23T09:00:00.000Z';
function setup() {
  let session: CustomerTelegramSession | null = null;
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: identity.id }]),
    $transaction: vi.fn(),
    user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Покупатель', phone: '+79990000007', telegramIdentity: null }) },
    order: { findFirst: vi.fn().mockResolvedValue({ type: 'DELIVERY', customerName: 'Другой получатель',
      customerPhone: '+79990000099', scheduledFor: new Date('2020-01-01') }) },
    address: { findFirst: vi.fn().mockResolvedValue(savedAddress), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: 10 }) },
    shopSettings: { findUniqueOrThrow: vi.fn().mockResolvedValue({ deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 0 }) },
    customerTelegramSession: {
      findUnique: vi.fn().mockImplementation(async () => session),
      deleteMany: vi.fn().mockImplementation(async () => { session = null; return { count: 1 }; }),
      create: vi.fn().mockImplementation(async ({ data }) => {
        session = { id: '22222222-2222-4222-8222-222222222222', orderId: null, promptMessageId: null,
          createdAt: new Date(), updatedAt: new Date(), ...data };
        return session;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }) => {
        if (!session || session.id !== where.id) throw new ConflictException();
        session = { ...session, ...data, updatedAt: new Date() };
        return session;
      }),
      delete: vi.fn().mockImplementation(async ({ where }) => {
        if (!session || session.id !== where.id) throw new ConflictException();
        session = null;
      }),
    },
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  const cart = {
    getIn: vi.fn().mockResolvedValue({ revision, valid: true, token: 'a'.repeat(64), subtotal: 32000,
      items: [{ productId: 11, qty: 1000, quantityUnit: 'GRAM' }] }),
    checkoutIn: vi.fn().mockResolvedValue({ id: 128 }),
  };
  const orders = { offer: vi.fn().mockResolvedValue({ preorderRequired: false, slots: [{ at: slot }] }), created: vi.fn() };
  const service = new CustomerCheckoutService(db as unknown as DbService, cart as unknown as CartService,
    orders as unknown as OrderService);
  return { db, cart, orders, service, get session() { return session!; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T09:00:00Z')); });
afterEach(() => vi.useRealTimers());

it('starts a returning customer at explicit confirmation using own current contact and saved address', async () => {
  const s = setup();
  const result = await s.service.start(identity, revision);
  expect(result.step).toBe('CONFIRM');
  expect(checkoutPayload.parse(result.payload)).toMatchObject({ type: 'DELIVERY', customerName: 'Покупатель',
    customerPhone: '+79990000007', fulfillmentMode: 'ASAP', addressId: 9,
    address: { city: 'Москва', street: 'Тестовая', house: '1', flat: '12' } });
  expect(JSON.stringify(result.payload)).not.toContain('Другой получатель');
  expect(checkoutPayload.parse(result.payload).scheduledFor).toBeUndefined();
  expect(s.db.address.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 7 } }));
  expect(s.db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: { userId: 7, status: { not: 'CANCELED' } }, select: { type: true },
  }));
  expect(s.cart.checkoutIn).not.toHaveBeenCalled();
});

it('can confirm pickup without an address and uses a verified own Telegram phone', async () => {
  const s = setup();
  s.db.order.findFirst.mockResolvedValueOnce({ type: 'PICKUP' });
  s.db.address.findFirst.mockResolvedValueOnce(null);
  s.db.user.findUniqueOrThrow.mockResolvedValueOnce({ name: 'Покупатель', phone: null,
    telegramIdentity: { phoneVerified: true, phoneNumber: '8 (999) 000-00-07' } });
  const result = await s.service.start(identity, revision);
  expect(result.step).toBe('CONFIRM');
  expect(checkoutPayload.parse(result.payload)).toMatchObject({ type: 'PICKUP', customerPhone: '+79990000007' });
  expect(checkoutPayload.parse(result.payload).address).toBeUndefined();
});

it.each(['missingPhone', 'unverifiedPhone', 'missingName', 'noPreviousOrder', 'noSavedAddress', 'invalidSavedAddress'])(
  'keeps the ordinary flow for %s and never copies old recipient data', async reason => {
    const s = setup();
    if (reason === 'missingPhone') s.db.user.findUniqueOrThrow.mockResolvedValueOnce({ name: 'Покупатель', phone: null, telegramIdentity: null });
    if (reason === 'unverifiedPhone') s.db.user.findUniqueOrThrow.mockResolvedValueOnce({ name: 'Покупатель', phone: null,
      telegramIdentity: { phoneVerified: false, phoneNumber: '+79990000099' } });
    if (reason === 'missingName') s.db.user.findUniqueOrThrow.mockResolvedValueOnce({ name: null, phone: '+79990000007', telegramIdentity: null });
    if (reason === 'noPreviousOrder') s.db.order.findFirst.mockResolvedValueOnce(null);
    if (reason === 'noSavedAddress') s.db.address.findFirst.mockResolvedValueOnce(null);
    if (reason === 'invalidSavedAddress') s.db.address.findFirst.mockResolvedValueOnce({ ...savedAddress, house: '' });
    const result = await s.service.start(identity, revision);
    expect(result.step).toBe('TYPE');
    expect(JSON.stringify(result.payload)).not.toContain('Другой получатель');
    expect(JSON.stringify(result.payload)).not.toContain('+79990000099');
  },
);

it.each([{ deliveryEnabled: false }, { minDeliverySubtotal: 50000 }])('does not fast-confirm an unavailable delivery option %o', async settings => {
  const s = setup();
  s.db.shopSettings.findUniqueOrThrow.mockResolvedValue({ deliveryEnabled: true, pickupEnabled: true,
    minDeliverySubtotal: 0, ...settings });
  const result = await s.service.start(identity, revision);
  expect(result.step).toBe('TYPE');
  expect(checkoutPayload.parse(result.payload).customerName).toBe('Покупатель');
});

it('requires a fresh available preparation time when ASAP is unavailable and never copies the old time', async () => {
  const s = setup();
  s.orders.offer.mockResolvedValue({ preorderRequired: true, slots: [{ at: slot }] });
  const result = await s.service.start(identity, revision);
  expect(result.step).toBe('TIME');
  expect(checkoutPayload.parse(result.payload).scheduledFor).toBeUndefined();
  expect(checkoutPayload.parse(result.payload).fulfillmentMode).toBeUndefined();
  expect(checkoutPayload.parse(result.payload).address).toMatchObject({ house: '1' });
  s.session.promptMessageId = 99;
  const scheduled = await s.service.reply(identity, '23.10.2026 12:00', 99);
  expect(scheduled.step).toBe('CONFIRM');
  expect(checkoutPayload.parse(scheduled.payload)).toMatchObject({ fulfillmentMode: 'SCHEDULED', scheduledFor: slot });
});

it('keeps unavailable or past preparation slots out of confirmation', async () => {
  const s = setup();
  s.orders.offer.mockResolvedValue({ preorderRequired: true, slots: [] });
  await s.service.start(identity, revision);
  s.session.promptMessageId = 99;
  const result = await s.service.reply(identity, '23.10.2026 12:00', 99);
  expect(result.step).toBe('TIME');
  expect(checkoutPayload.parse(result.payload).scheduledFor).toBeUndefined();
});

it('edits the selected field and returns to confirmation without losing other correct fields', async () => {
  const s = setup();
  const first = await s.service.start(identity, revision);
  const editing = await s.service.choose(identity, first.id, 'edit_name');
  expect(editing.step).toBe('NAME');
  expect(checkoutPayload.parse(editing.payload).customerPhone).toBe('+79990000007');
  s.session.promptMessageId = 99;
  const result = await s.service.reply(identity, 'Новое имя', 99);
  expect(result.step).toBe('CONFIRM');
  expect(checkoutPayload.parse(result.payload)).toMatchObject({ customerName: 'Новое имя', customerPhone: '+79990000007',
    address: { house: '1' }, fulfillmentMode: 'ASAP' });
  await expect(s.service.choose(identity, first.id, 'edit_phone')).rejects.toBeInstanceOf(ConflictException);
});

it('legacy edit and changing fulfillment preserve name and phone', async () => {
  const s = setup();
  const first = await s.service.start(identity, revision);
  const editing = await s.service.choose(identity, first.id, 'edit');
  expect(editing.step).toBe('TYPE');
  expect(checkoutPayload.parse(editing.payload).customerName).toBe('Покупатель');
  const pickup = await s.service.choose(identity, editing.id, 'pickup');
  expect(pickup.step).toBe('CONFIRM');
  expect(checkoutPayload.parse(pickup.payload)).toMatchObject({ type: 'PICKUP', customerPhone: '+79990000007' });
  expect(checkoutPayload.parse(pickup.payload).address).toBeUndefined();
});

it('rechecks availability on confirmation and consumes the session only for a successful explicit confirm', async () => {
  const s = setup();
  const first = await s.service.start(identity, revision);
  s.orders.offer.mockResolvedValueOnce({ preorderRequired: true, slots: [] });
  await expect(s.service.confirm(identity, first.id)).rejects.toBeInstanceOf(ConflictException);
  expect(s.db.customerTelegramSession.delete).not.toHaveBeenCalled();
  expect(s.cart.checkoutIn).not.toHaveBeenCalled();
  await s.service.confirm(identity, first.id);
  expect(s.cart.checkoutIn).toHaveBeenCalledWith(expect.anything(), 7, revision,
    expect.objectContaining({ quoteToken: 'a'.repeat(64), fulfillmentMode: 'ASAP' }));
  expect(s.orders.created).toHaveBeenCalledWith(128);
  await expect(s.service.confirm(identity, first.id)).rejects.toBeInstanceOf(ConflictException);
  expect(s.cart.checkoutIn).toHaveBeenCalledTimes(1);
});

it('retains stale-cart protection and sends unavailable confirmation back to time selection on resume', async () => {
  const s = setup();
  await expect(s.service.start(identity, '33333333-3333-4333-8333-333333333333')).rejects.toBeInstanceOf(ConflictException);
  const first = await s.service.start(identity, revision);
  s.orders.offer.mockResolvedValueOnce({ preorderRequired: true, slots: [{ at: slot }] });
  const resumed = await s.service.resume(identity);
  expect(resumed?.step).toBe('TIME');
  expect(resumed?.id).not.toBe(first.id);
  expect(s.cart.checkoutIn).not.toHaveBeenCalled();
});

it('reopening checkout rechecks an existing confirmation while preserving its valid contact fields', async () => {
  const s = setup();
  const first = await s.service.start(identity, revision);
  s.orders.offer.mockResolvedValueOnce({ preorderRequired: true, slots: [{ at: slot }] });
  const reopened = await s.service.start(identity, revision);
  expect(reopened.step).toBe('TIME');
  expect(reopened.id).not.toBe(first.id);
  expect(checkoutPayload.parse(reopened.payload)).toMatchObject({ customerName: 'Покупатель', customerPhone: '+79990000007' });
});


it('edits or clears only the delivery comment and requires the exact current session revision', async () => {
  const s = setup();
  const first = await s.service.start(identity, revision);
  const editing = await s.service.choose(identity, first.id, 'edit_comment');
  expect(editing.step).toBe('COMMENT');
  s.session.promptMessageId = 99;
  const saved = await s.service.reply(identity, 'Позвоните перед приездом', 99);
  expect(saved.step).toBe('CONFIRM');
  expect(checkoutPayload.parse(saved.payload)).toMatchObject({ customerName: 'Покупатель',
    customerPhone: '+79990000007', address: { city: 'Москва', street: 'Тестовая', house: '1', flat: '12', comment: 'Позвоните перед приездом' } });
  await expect(s.service.choose(identity, first.id, 'edit_comment')).rejects.toBeInstanceOf(ConflictException);
  await s.service.choose(identity, saved.id, 'edit_comment');
  s.session.promptMessageId = 100;
  const cleared = await s.service.reply(identity, '-', 100);
  expect(checkoutPayload.parse(cleared.payload).address?.comment).toBe('');
  expect(s.cart.checkoutIn).not.toHaveBeenCalled();
});

it('does not allow a delivery comment to create an address on a pickup order', async () => {
  const s = setup();
  s.db.order.findFirst.mockResolvedValueOnce({ type: 'PICKUP' });
  const first = await s.service.start(identity, revision);
  await expect(s.service.choose(identity, first.id, 'edit_comment')).rejects.toBeInstanceOf(ConflictException);
  expect(checkoutPayload.parse(s.session.payload).address).toBeUndefined();
});

it('prepares pickup with an empty cart and consumes that choice only at ordinary checkout', async () => {
  const s = setup();
  const first = await s.service.receiving(identity);
  expect(first.action).toBe('CHECKOUT');
  const ready = await s.service.chooseReceiving(identity, { kind: 'receive', revision: first.id, choice: 'pickup' });
  expect(receivingPayload.parse(ready.payload).stage).toBe('DONE');
  expect(s.cart.getIn).not.toHaveBeenCalled(); expect(s.cart.checkoutIn).not.toHaveBeenCalled();
  expect(s.db.address.updateMany).not.toHaveBeenCalled();
  await expect(s.service.chooseReceiving(identity, { kind: 'receive', revision: first.id, choice: 'pickup' })).rejects.toBeInstanceOf(ConflictException);
  await expect(s.service.confirm(identity, ready.id)).rejects.toBeInstanceOf(ConflictException);
  const confirmation = await s.service.start(identity, revision);
  expect(checkoutPayload.parse(confirmation.payload).type).toBe('PICKUP');
  expect(s.cart.checkoutIn).not.toHaveBeenCalled(); expect(s.orders.created).not.toHaveBeenCalled();
});
it('binds a saved-address selection to ownership, version and nonce, and keeps its ID for checkout', async () => {
  const s = setup();
  let step = await s.service.receiving(identity);
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'delivery' });
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'view', value: 9 });
  expect(s.db.address.findFirst).toHaveBeenLastCalledWith({ where: { id: 9, userId: 7 } });
  const view = step;
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'use' });
  expect(receivingPayload.parse(step.payload).stage).toBe('DONE');
  expect(s.db.address.updateMany).toHaveBeenCalledWith({ where: { id: 9, userId: 7, updatedAt: savedAddress.updatedAt }, data: { isDefault: true } });
  await expect(s.service.chooseReceiving(identity, { kind: 'receive', revision: view.id, choice: 'use' })).rejects.toBeInstanceOf(ConflictException);
  await s.service.start(identity, revision);
  expect(s.db.address.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId: 7, id: 9 } }));
  expect(s.cart.checkoutIn).not.toHaveBeenCalled();
});
it.each(['foreign', 'changed'])('rejects a %s saved address without changing it or creating an order', async reason => {
  const s = setup();
  let step = await s.service.receiving(identity);
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'delivery' });
  if (reason === 'foreign') s.db.address.findFirst.mockResolvedValueOnce(null);
  if (reason === 'foreign') {
    await expect(s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'view', value: 999 })).rejects.toBeInstanceOf(ConflictException);
    expect(s.db.address.updateMany).not.toHaveBeenCalled();
  } else {
    step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'view', value: 9 });
    s.db.address.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'use' })).rejects.toBeInstanceOf(ConflictException);
    expect(s.db.address.updateMany).toHaveBeenCalledTimes(1);
  }
  expect(s.cart.checkoutIn).not.toHaveBeenCalled();
});
it.each(['new', 'edit'] as const)('saves a %s address only after bound replies and explicit review confirmation', async mode => {
  const s = setup();
  let step = await s.service.receiving(identity);
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'delivery' });
  if (mode === 'edit') step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'view', value: 9 });
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: mode });
  s.session.promptMessageId = 90;
  await expect(s.service.replyReceiving(identity, 'Москва', 89)).rejects.toBeInstanceOf(ConflictException);
  for (const text of ['Москва', 'Новая', '2', '3', '-', '-', '-', 'Позвоните']) {
    s.session.promptMessageId = 90;
    step = await s.service.replyReceiving(identity, text, 90);
  }
  expect(receivingPayload.parse(step.payload).stage).toBe('REVIEW');
  expect(s.db.address.create).not.toHaveBeenCalled(); expect(s.db.address.updateMany).not.toHaveBeenCalled();
  const review = step;
  step = await s.service.chooseReceiving(identity, { kind: 'receive', revision: step.id, choice: 'save' });
  expect(receivingPayload.parse(step.payload).stage).toBe('DONE');
  if (mode === 'new') expect(s.db.address.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 7, label: 'Доставка', city: 'Москва', street: 'Новая', house: '2', isDefault: true }) });
  else expect(s.db.address.updateMany).toHaveBeenCalledWith({ where: { id: 9, userId: 7, updatedAt: savedAddress.updatedAt },
    data: expect.objectContaining({ street: 'Новая', lat: null, lng: null, fiasId: null }) });
  await expect(s.service.chooseReceiving(identity, { kind: 'receive', revision: review.id, choice: 'save' })).rejects.toBeInstanceOf(ConflictException);
  expect(s.cart.checkoutIn).not.toHaveBeenCalled(); expect(s.orders.created).not.toHaveBeenCalled();
});
it('expires a receiving preference and rechecks disabled methods', async () => {
  const s = setup();
  const first = await s.service.receiving(identity);
  s.db.shopSettings.findUniqueOrThrow.mockResolvedValueOnce({ deliveryEnabled: false, pickupEnabled: true, minDeliverySubtotal: 0 });
  await expect(s.service.chooseReceiving(identity, { kind: 'receive', revision: first.id, choice: 'delivery' })).rejects.toThrow('недоступен');
  await s.service.chooseReceiving(identity, { kind: 'receive', revision: first.id, choice: 'pickup' });
  vi.advanceTimersByTime(31 * 60000);
  const confirmation = await s.service.start(identity, revision);
  expect(checkoutPayload.parse(confirmation.payload).type).toBe('DELIVERY');
});
