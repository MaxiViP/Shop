import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';

// Both callers hold the same Order row lock; no customer-only cancellation shortcut.
export async function cancelOrder(db: Prisma.TransactionClient, id: number) {
  const order = await db.order.findUniqueOrThrow({
    where: { id },
    include: { payment: true, delivery: true },
  });
  if (order.payment?.status === 'PAID')
    throw new ConflictException(
      'Оплаченный заказ требует отдельного возврата средств',
    );
  if (!['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'].includes(order.status))
    throw new BadRequestException('Заказ нельзя отменить');
  if (
    order.delivery &&
    !['PENDING', 'ASSIGNED', 'CANCELED'].includes(order.delivery.status)
  )
    throw new BadRequestException('Заказ уже передан курьеру');
  if (order.delivery?.provider === 'YANDEX' && order.delivery.externalOrderId)
    throw new BadRequestException(
      'Созданную Яндекс Доставку нужно отменять через Яндекс',
    );
  if (order.delivery)
    await db.delivery.update({
      where: { id: order.delivery.id },
      data: { status: 'CANCELED' },
    });
  await db.orderPayment.updateMany({
    where: { orderId: id, status: { in: ['AWAITING', 'REPORTED'] } },
    data: { status: 'CANCELED' },
  });
  await db.orderIssue.updateMany({
    where: {
      orderId: id,
      status: { in: ['WAITING_CUSTOMER', 'WAITING_SELLER'] },
    },
    data: {
      status: 'CANCELED',
      resolution: 'CANCEL_ORDER',
      resolvedAt: new Date(),
    },
  });
  await db.orderNotification.updateMany({
    where: {
      orderId: id,
      status: { in: ['PENDING', 'UNCONFIGURED', 'FAILED'] },
    },
    data: { status: 'CANCELED' },
  });
  return db.order.update({ where: { id }, data: { status: 'CANCELED' } });
}
