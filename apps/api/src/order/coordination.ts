import { ConflictException } from '@nestjs/common';
import type { OrderItem, Prisma, MessageAuthor } from '../db/gen/client.js';
import { outsideTolerance, approvedWeight } from './assembly.js';

export const issueSummary = {
  where: { status: { in: ['WAITING_CUSTOMER', 'WAITING_SELLER'] } },
  select: { id: true, status: true },
} satisfies Prisma.Order$issuesArgs;

export async function message(
  db: Prisma.TransactionClient,
  orderId: number,
  text: string,
  authorType: MessageAuthor = 'SYSTEM',
  authorUserId: number | null = null,
  issueId: number | null = null,
  recipient: 'customer' | 'staff' | 'both' = 'both',
) {
  const saved = await db.orderChatMessage.create({
    data: { orderId, text, authorType, authorUserId, issueId, recipient },
  });
  await db.order.update({
    where: { id: orderId },
    data: {
      ...(recipient !== 'staff' ? { customerUnread: { increment: 1 } } : {}),
      ...(recipient !== 'customer' ? { staffUnread: { increment: 1 } } : {}),
    },
  });
  return saved;
}

export async function actionNotification(
  db: Prisma.TransactionClient,
  issue: { id: number; orderId: number; version: number },
) {
  await db.orderNotification.upsert({
    where: { dedupeKey: `issue:${issue.id}:${issue.version}` },
    create: {
      orderId: issue.orderId,
      issueId: issue.id,
      issueVersion: issue.version,
      type: 'ACTION_REQUIRED',
      dedupeKey: `issue:${issue.id}:${issue.version}`,
    },
    update: {},
  });
}

// Caller holds the parent Order FOR UPDATE lock. An approval never survives a reset/change.
export async function syncIssue(
  db: Prisma.TransactionClient,
  order: { id: number; weightToleranceBps: number },
  item: OrderItem,
  userId: number | null,
) {
  const previous = await db.orderIssue.findUnique({
    where: { orderItemId: item.id },
  });
  const outside =
    item.status === 'PICKED' &&
    outsideTolerance(
      item.unit,
      item.qty,
      item.actualQty!,
      order.weightToleranceBps,
    );
  if (!previous && item.status !== 'MISSING' && !outside) return;
  if (previous?.replacementItemId)
    throw new ConflictException('Исходный товар уже заменён');
  const waiting = outside || item.status === 'MISSING';
  const status = waiting
    ? 'WAITING_CUSTOMER'
    : item.status === 'PENDING'
      ? 'WAITING_SELLER'
      : 'RESOLVED';
  const issue = await db.orderIssue.upsert({
    where: { orderItemId: item.id },
    create: {
      orderId: order.id,
      orderItemId: item.id,
      type: item.status === 'MISSING' ? 'MISSING_ITEM' : 'WEIGHT_DEVIATION',
      status,
      requestedQty: item.qty,
      actualQty: item.actualQty,
      createdById: userId,
    },
    update: {
      type: item.status === 'MISSING' ? 'MISSING_ITEM' : 'WEIGHT_DEVIATION',
      status,
      version: { increment: 1 },
      actualQty: item.actualQty,
      approvedActualQty: null,
      resolution: status === 'RESOLVED' ? 'SELLER_ADJUSTED' : null,
      resolvedAt: status === 'RESOLVED' ? new Date() : null,
      proposedProductId: null,
      proposedName: null,
      proposedSlug: null,
      proposedPrice: null,
      proposedPriceQty: null,
      proposedUnit: null,
      proposedQty: null,
      proposedImageUrl: null,
    },
  });
  await db.orderNotification.updateMany({
    where: {
      issueId: issue.id,
      status: { in: ['PENDING', 'FAILED', 'UNCONFIGURED'] },
    },
    data: { status: 'CANCELED' },
  });
  await message(
    db,
    order.id,
    item.status === 'MISSING'
      ? `Продавец сообщил: ${item.productName} нет в наличии.`
      : outside
        ? `${item.productName}: заказано ${item.qty} г, собрано ${item.actualQty} г. Требуется ваше решение.`
        : status === 'RESOLVED'
          ? `${item.productName}: вес скорректирован в пределах допуска.`
          : `${item.productName}: возвращён в сборку; прежнее предложение недействительно.`,
    'SYSTEM',
    userId,
    issue.id,
    'customer',
  );
  if (waiting) await actionNotification(db, issue);
}

export async function checkIssues(
  db: Prisma.TransactionClient,
  orderId: number,
  items: OrderItem[],
  bps: number,
) {
  const issues = await db.orderIssue.findMany({ where: { orderId } });
  for (const item of items) {
    if (
      item.status !== 'PICKED' ||
      !outsideTolerance(item.unit, item.qty, item.actualQty!, bps)
    )
      continue;
    const approval = approvedWeight(
      issues.find((issue) => issue.orderItemId === item.id),
      item.actualQty,
    );
    if (!approval)
      throw new ConflictException({
        code: 'WEIGHT_CONFIRMATION_REQUIRED',
        message: 'Требуется подтверждение покупателя',
        itemIds: [item.id],
      });
  }
  if (
    issues.some((issue) =>
      ['WAITING_CUSTOMER', 'WAITING_SELLER'].includes(issue.status),
    )
  )
    throw new ConflictException({
      code: 'ORDER_ACTION_REQUIRED',
      message: 'Сначала разрешите проблемы заказа',
    });
}
