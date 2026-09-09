import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  OrderStatus,
  PaymentStatus,
  DeliveryStatus,
  UserRole,
  Prisma,
} from '../db/gen/client.js';
import { message, actionNotification } from './coordination.js';

export const cancellationHistory = {
  orderBy: { id: 'desc' },
  select: {
    id: true,
    fromStatus: true,
    paymentStatus: true,
    deliveryStatus: true,
    reason: true,
    canceledAt: true,
    canceledByRole: true,
    canceledBy: { select: { id: true, name: true } },
    restoredAt: true,
    restoredByRole: true,
    restoredBy: { select: { id: true, name: true } },
  },
} satisfies Prisma.Order$cancellationsArgs;

type Restorable = {
  status: OrderStatus;
  assemblyFinalizedAt: Date | null;
  finalSubtotal: number | null;
  payment: { status: PaymentStatus; amount: number } | null;
  delivery: {
    provider: string;
    status: DeliveryStatus;
    externalOrderId: string | null;
  } | null;
};
type Cancellation = {
  fromStatus: OrderStatus;
  paymentStatus: PaymentStatus | null;
  deliveryStatus: DeliveryStatus | null;
  restoredAt: Date | null;
};

export function restoreProblem(order: Restorable, previous?: Cancellation) {
  if (order.status !== 'CANCELED') return 'Заказ не отменён';
  if (!previous || previous.restoredAt)
    return 'Восстановление недоступно для старого заказа: прежнее состояние неизвестно';
  if (
    !['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'].includes(previous.fromStatus)
  )
    return 'Прежнее состояние не допускает восстановления';
  if (
    ['PAID', 'REPORTED'].includes(order.payment?.status ?? '') ||
    ['PAID', 'REPORTED'].includes(previous.paymentStatus ?? '')
  )
    return 'Оплата требует отдельной проверки';
  if (
    order.delivery &&
    (order.delivery.externalOrderId ||
      order.delivery.provider === 'OTHER' ||
      order.delivery.status !== 'CANCELED')
  )
    return 'Заказ связан с внешней доставкой';
  if (previous.fromStatus === 'READY') {
    if (
      !order.assemblyFinalizedAt ||
      order.finalSubtotal === null ||
      previous.paymentStatus !== 'AWAITING' ||
      order.payment?.status !== 'CANCELED' ||
      order.payment.amount !== order.finalSubtotal
    )
      return 'Не удалось подтвердить зафиксированную сумму оплаты';
  } else if (
    order.assemblyFinalizedAt ||
    (previous.paymentStatus && previous.paymentStatus !== 'CANCELED')
  )
    return 'Состояние сборки и оплаты несовместимо';
  return null;
}

// Both callers hold the same Order row lock; no customer-only cancellation shortcut.
export async function cancelOrder(
  db: Prisma.TransactionClient,
  id: number,
  userId: number | null = null,
  role: UserRole = 'USER',
  reason?: string,
) {
  const order = await db.order.findUniqueOrThrow({
    where: { id },
    include: { payment: true, delivery: true },
  });
  if (['PAID', 'REPORTED'].includes(order.payment?.status ?? ''))
    throw new ConflictException(
      'Оплата или сообщение о переводе требуют отдельной проверки; простая отмена недоступна',
    );
  if (order.status === 'CANCELED') return order;
  if (!['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'].includes(order.status))
    throw new BadRequestException('Заказ нельзя отменить');
  if (
    order.delivery &&
    !['PENDING', 'ASSIGNED', 'CANCELED'].includes(order.delivery.status)
  )
    throw new BadRequestException('Заказ уже передан курьеру');
  if (
    order.delivery &&
    (order.delivery.externalOrderId || order.delivery.provider === 'OTHER')
  )
    throw new BadRequestException(
      'Оформленную внешнюю доставку нужно отменять отдельным процессом',
    );
  await db.orderCancellation.create({
    data: {
      orderId: id,
      fromStatus: order.status,
      paymentStatus: order.payment?.status,
      deliveryStatus: order.delivery?.status,
      canceledById: userId,
      canceledByRole: role,
      reason: reason?.trim() || null,
    },
  });
  if (order.delivery)
    await db.delivery.update({
      where: { id: order.delivery.id },
      data: { status: 'CANCELED' },
    });
  await db.orderPayment.updateMany({
    where: { orderId: id, status: { in: ['AWAITING', 'REPORTED'] } },
    data: { status: 'CANCELED' },
  });
  const issues = await db.orderIssue.findMany({
    where: {
      orderId: id,
      status: { in: ['WAITING_CUSTOMER', 'WAITING_SELLER'] },
    },
  });
  for (const issue of issues)
    await db.orderIssue.update({
      where: { id: issue.id },
      data: {
        suspendedStatus: issue.status,
        suspendedResolution: issue.resolution,
        suspendedResolvedAt: issue.resolvedAt,
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
  const saved = await db.order.update({
    where: { id },
    data: { status: 'CANCELED' },
  });
  await message(
    db,
    id,
    role === 'USER' ? 'Покупатель отменил заказ.' : 'Заказ отменён продавцом.',
    'SYSTEM',
    userId,
    null,
    role === 'USER' ? 'staff' : 'customer',
  );
  return saved;
}

// Caller holds the same parent Order lock as cancel/finalize/payment.
export async function restoreOrder(
  db: Prisma.TransactionClient,
  id: number,
  userId: number,
  role: UserRole,
  cancellationId: number,
) {
  const order = await db.order.findUniqueOrThrow({
    where: { id },
    include: { payment: true, delivery: true },
  });
  const previous = await db.orderCancellation.findFirst({
    where: { orderId: id },
    orderBy: { id: 'desc' },
  });
  if (previous?.id !== cancellationId)
    throw new ConflictException('История отмены изменилась. Обновите заказ');
  if (order.status !== 'CANCELED' && previous.restoredAt) return order;
  const problem = restoreProblem(order, previous);
  if (problem) throw new ConflictException(problem);
  if (previous.fromStatus === 'READY')
    await db.orderPayment.update({
      where: { orderId: id },
      data: { status: 'AWAITING' },
    });
  if (order.delivery)
    await db.delivery.update({
      where: { id: order.delivery.id },
      data: { status: previous.deliveryStatus ?? 'PENDING' },
    });
  const issues = await db.orderIssue.findMany({
    where: { orderId: id, suspendedStatus: { not: null } },
  });
  for (const issue of issues) {
    const restored = await db.orderIssue.update({
      where: { id: issue.id },
      data: {
        status: issue.suspendedStatus!,
        resolution: issue.suspendedResolution,
        resolvedAt: issue.suspendedResolvedAt,
        suspendedStatus: null,
        suspendedResolution: null,
        suspendedResolvedAt: null,
        version: { increment: 1 },
      },
    });
    if (restored.status === 'WAITING_CUSTOMER')
      await actionNotification(db, restored);
  }
  const restored = await db.orderCancellation.update({
    where: { id: previous.id },
    data: {
      restoredAt: new Date(),
      restoredById: userId,
      restoredByRole: role,
    },
  });
  const saved = await db.order.update({
    where: { id },
    data: { status: previous.fromStatus },
  });
  if (previous.fromStatus === 'READY')
    await db.orderNotification.create({
      data: {
        orderId: id,
        type: 'PAYMENT_READY',
        dedupeKey: `restored:${restored.id}`,
      },
    });
  await message(
    db,
    id,
    'Заказ восстановлен.',
    'SYSTEM',
    userId,
    null,
    'customer',
  );
  return saved;
}
