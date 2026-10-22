import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';

type Data = Prisma.OrderGetPayload<{ include: {
  items: true; issues: true; extras: true; payment: true; delivery: true;
} }>;
export type ReviewOrder = Pick<Data, 'status' | 'type' | 'updatedAt' | 'assemblyFinalizedAt' |
  'fulfillmentMode' | 'scheduledFor' | 'deliveryPrice' | 'finalSubtotal' | 'finalTotal'> & {
  items: Pick<Data['items'][number], 'id' | 'status' | 'qty' | 'price' | 'actualPrice' |
    'priceQty' | 'actualQty' | 'actualTotal' | 'actualWeightGrams' | 'pieceWeights'>[];
  issues: Pick<Data['issues'][number], 'id' | 'version' | 'status' | 'resolution' | 'replacementItemId'>[];
  extras: Pick<Data['extras'][number], 'id' | 'version' | 'status' | 'title' | 'comment' |
    'quantity' | 'unitPrice' | 'amount'>[];
  payment: Pick<NonNullable<Data['payment']>, 'status' | 'amount' | 'method'> | null;
  delivery: Pick<NonNullable<Data['delivery']>, 'provider' | 'status' | 'externalOrderId' | 'price'> | null;
};

// Normalize the shared DTO/DB fields. Computed queue estimates, property order
// and private financial fields cannot invalidate an otherwise identical review.
export function reviewSnapshot(order: ReviewOrder): string {
  const byId = <T extends { id: number }>(rows: T[]) => rows.sort((a, b) => a.id - b.id);
  return createHash('sha256').update(JSON.stringify({
    status: order.status, type: order.type, updatedAt: order.updatedAt,
    assemblyFinalizedAt: order.assemblyFinalizedAt, fulfillmentMode: order.fulfillmentMode,
    scheduledFor: order.scheduledFor, deliveryPrice: order.deliveryPrice,
    finalSubtotal: order.finalSubtotal, finalTotal: order.finalTotal,
    items: byId(order.items.map(item => ({
      id: item.id, status: item.status, qty: item.qty, price: item.price,
      actualPrice: item.actualPrice, priceQty: item.priceQty, actualQty: item.actualQty,
      actualTotal: item.actualTotal, actualWeightGrams: item.actualWeightGrams, pieceWeights: item.pieceWeights,
    }))),
    issues: byId(order.issues.map(issue => ({ id: issue.id, version: issue.version,
      status: issue.status, resolution: issue.resolution, replacementItemId: issue.replacementItemId }))),
    extras: byId(order.extras.map(extra => ({ id: extra.id, version: extra.version, status: extra.status,
      title: extra.title, comment: extra.comment, quantity: extra.quantity, unitPrice: extra.unitPrice, amount: extra.amount }))),
    payment: order.payment ? { status: order.payment.status, amount: order.payment.amount, method: order.payment.method } : null,
    delivery: order.delivery ? { provider: order.delivery.provider, status: order.delivery.status,
      externalOrderId: order.delivery.externalOrderId, price: order.delivery.price } : null,
  })).digest('hex');
}

// Caller already holds Order FOR UPDATE. No displayed snapshot may be checked
// only before the domain transaction: another seller could change it meanwhile.
export async function assertStaffReview(db: Prisma.TransactionClient, id: number, expected?: string) {
  if (expected === undefined) return;
  const order = await db.order.findUnique({ where: { id },
    include: { items: true, issues: true, extras: true, payment: true, delivery: true } });
  if (!order || reviewSnapshot(order) !== expected)
    throw new ConflictException('Заказ изменился. Откройте действие заново и проверьте актуальные данные.');
}
