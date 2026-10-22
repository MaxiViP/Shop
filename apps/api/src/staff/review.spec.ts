import { ConflictException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { NotificationService } from '../order/notification.service.js';
import { StaffService } from './staff.service.js';
import { assertStaffReview, reviewSnapshot, type ReviewOrder } from './review.js';

function fixture(): ReviewOrder {
  return { status: 'ASSEMBLING', type: 'PICKUP', updatedAt: new Date('2026-10-22T10:00:00Z'),
    assemblyFinalizedAt: null, fulfillmentMode: 'ASAP', scheduledFor: null,
    deliveryPrice: 0, finalSubtotal: null, finalTotal: null,
    items: [{ id: 10, status: 'PICKED', qty: 750, price: 32000, actualPrice: null,
      priceQty: 1000, actualQty: 782, actualTotal: 25024, actualWeightGrams: null, pieceWeights: null },
      { id: 11, status: 'PENDING', qty: 1, price: 7000, actualPrice: null,
        priceQty: 1, actualQty: null, actualTotal: null, actualWeightGrams: null, pieceWeights: null }],
    extras: [{ id: 20, version: 1, status: 'ACTIVE', title: 'Упаковка', comment: null,
      quantity: 1, unitPrice: 1000, amount: 1000 }],
    issues: [{ id: 30, version: 1, status: 'WAITING_CUSTOMER', resolution: null, replacementItemId: null }],
    payment: null, delivery: null };
}
it('normalizes DB/DTO field order and relation order without changing the original arrays', () => {
  const order = fixture(), token = reviewSnapshot(order);
  expect(reviewSnapshot({ ...order, items: [...order.items].reverse() })).toBe(token);
  expect(order.items.map(item => item.id)).toEqual([10, 11]);
  expect(reviewSnapshot({ ...order, items: order.items.map(item => ({ ...item, privateSnapshot: 'internal' })) })).toBe(token);
});
const changes: [string, (order: ReviewOrder) => void][] = [
  ['actual quantity', order => { order.items[0]!.actualQty = 783; }],
  ['actual price', order => { order.items[0]!.actualPrice = 33000; }],
  ['piece weights', order => { order.items[0]!.pieceWeights = [783]; }],
  ['issue version', order => { order.issues[0]!.version++; }],
  ['buyer resolution', order => { order.issues[0]!.status = 'RESOLVED'; order.issues[0]!.resolution = 'REMOVE_ITEM'; }],
  ['extra content', order => { order.extras[0]!.title = 'Другая упаковка'; }],
  ['payment amount', order => { order.payment = { amount: 27000, status: 'AWAITING', method: 'SBP' }; }],
  ['payment confirmation', order => { order.payment = { amount: 25024, status: 'PAID', method: 'SBP' }; }],
  ['delivery', order => { order.delivery = { provider: 'OTHER', status: 'ASSIGNED', externalOrderId: null, price: 10000 }; }],
  ['final total', order => { order.finalTotal = 27000; }],
];
it.each(changes)('rejects changed %s even if updatedAt stays in the same millisecond', async (_name, change) => {
  const order = fixture(), expected = reviewSnapshot(order), before = order.updatedAt.getTime();
  change(order);
  expect(order.updatedAt.getTime()).toBe(before);
  const findUnique = vi.fn().mockResolvedValue(order);
  await expect(assertStaffReview({ order: { findUnique } } as unknown as Prisma.TransactionClient, 1, expected))
    .rejects.toBeInstanceOf(ConflictException);
});
it('accepts only an identical locked snapshot and skips extra reads for existing callers', async () => {
  const order = fixture(), findUnique = vi.fn().mockResolvedValue(order);
  const tx = { order: { findUnique } } as unknown as Prisma.TransactionClient;
  await assertStaffReview(tx, 1);
  expect(findUnique).not.toHaveBeenCalled();
  await assertStaffReview(tx, 1, reviewSnapshot(order));
  expect(findUnique).toHaveBeenCalledOnce();
  findUnique.mockResolvedValueOnce(null);
  await expect(assertStaffReview(tx, 1, reviewSnapshot(order))).rejects.toBeInstanceOf(ConflictException);
});
const guarded: [string, (service: StaffService, expected: string) => Promise<unknown>][] = [
  ['reset', (service, expected) => service.item(1, 10, { status: 'PENDING' }, 7, { userId: 7, role: 'SELLER' }, expected)],
  ['remove extra', (service, expected) => service.extra(1, 7, null, 20, 1, { userId: 7, role: 'SELLER' }, expected)],
  ['finish assembly', (service, expected) => service.finishAssembly(1, { userId: 7, role: 'SELLER' }, expected)],
  ['reopen', (service, expected) => service.reopen(1, { userId: 7, role: 'SELLER' }, expected)],
  ['confirm payment', (service, expected) => service.confirmPayment(1, 7, undefined, { userId: 7, role: 'SELLER' }, expected)],
];
it.each(guarded)('%s rechecks the review after the Order lock and before any domain write', async (_name, call) => {
  const order = fixture(), expected = reviewSnapshot(order), events: string[] = [];
  order.items[0]!.actualQty = 900;
  const write = vi.fn();
  const tx = { $queryRaw: vi.fn(async () => { events.push('lock'); return [{ id: 1 }]; }),
    order: { findUnique: vi.fn(async () => { events.push('read'); return order; }), update: write },
    orderItem: { update: write }, orderExtra: { update: write }, orderPayment: { update: write } };
  const db = { $transaction: vi.fn((action: (client: typeof tx) => Promise<unknown>) => action(tx)) };
  const dispatch = vi.fn();
  const service = new StaffService(db as unknown as DbService, { dispatch } as unknown as NotificationService);
  await expect(call(service, expected)).rejects.toBeInstanceOf(ConflictException);
  expect(events).toEqual(['lock', 'read', 'read']);
  expect(write).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
