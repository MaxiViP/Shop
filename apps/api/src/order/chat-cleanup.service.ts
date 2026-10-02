import { Injectable, Logger } from '@nestjs/common';
import type { ChatImageRetention, OrderStatus } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { ChatImagesService } from './chat-images.service.js';

const DAY = 24 * 60 * 60 * 1000;
const logger = new Logger('ChatCleanup');

export function imageExpiry(input: {
  retention: ChatImageRetention;
  createdAt: Date;
  orderStatus: OrderStatus;
  completedAt: Date | null;
  canceledAt: Date | null;
  orderUpdatedAt: Date;
  issue?: { status: string; updatedAt: Date; resolvedAt: Date | null } | null;
}) {
  const terminal = input.orderStatus === 'COMPLETED'
    ? input.completedAt ?? input.orderUpdatedAt
    : input.orderStatus === 'CANCELED'
      ? input.canceledAt ?? input.orderUpdatedAt
      : null;
  if (input.retention === 'OPERATIONAL')
    return terminal ? new Date(Math.max(terminal.getTime(), input.createdAt.getTime()) + 7 * DAY) : null;
  // Without a linked issue, order completion/cancellation is the only reliable
  // end of an active problem conversation.
  if (!input.issue && !terminal) return null;
  if (input.issue && !['RESOLVED', 'CANCELED'].includes(input.issue.status))
    return null;
  const event = Math.max(input.createdAt.getTime(), terminal?.getTime() ?? 0,
    input.issue?.updatedAt.getTime() ?? 0, input.issue?.resolvedAt?.getTime() ?? 0);
  return new Date(event + 90 * DAY);
}

@Injectable()
export class ChatCleanupService {
  constructor(private readonly db: DbService, private readonly images: ChatImagesService) {}

  async run(now = new Date()) {
    let cursor = 0;
    let deleted = 0;
    for (;;) {
      const rows = await this.db.orderChatMessage.findMany({
        where: { id: { gt: cursor }, imageKey: { not: null }, imageRetention: { not: null } },
        orderBy: { id: 'asc' }, take: 200, select: { id: true, orderId: true },
      });
      if (!rows.length) break;
      for (const candidate of rows) {
        cursor = candidate.id;
        const removed = await this.db.$transaction(async (tx) => {
          // Parameterized order lock serializes with status changes and photo messages.
          await tx.$queryRawUnsafe('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE', candidate.orderId);
          const row = await tx.orderChatMessage.findUnique({
            where: { id: candidate.id },
            include: { order: { include: { cancellations: {
              where: { restoredAt: null }, orderBy: { canceledAt: 'desc' }, take: 1,
            } } }, issue: true },
          });
          if (!row?.imageKey || !row.imageRetention || row.imageDeletedAt) return false;
          const expiry = imageExpiry({
            retention: row.imageRetention, createdAt: row.createdAt,
            orderStatus: row.order.status, completedAt: row.order.completedAt,
            canceledAt: row.order.cancellations[0]?.canceledAt ?? null,
            orderUpdatedAt: row.order.updatedAt, issue: row.issue,
          });
          if (row.imageExpiresAt?.getTime() !== (expiry?.getTime() ?? undefined))
            await tx.orderChatMessage.update({
              where: { id: row.id }, data: { imageExpiresAt: expiry },
            });
          if (!expiry || expiry > now) return false;
          await this.images.remove(row.imageKey);
          await tx.orderChatMessage.update({
            where: { id: row.id },
            data: { imageKey: null, imageDeletedAt: now, imageExpiresAt: expiry },
          });
          return true;
        });
        if (removed) deleted++;
      }
    }
    const orphans = await this.sweepOrphans(now);
    logger.log('Chat image cleanup: ' + deleted + ' expired messages; ' + orphans + ' orphan files');
    return { deleted, orphans };
  }

  async sweepOrphans(now = new Date()) {
    return this.images.sweepOrphans(now, async key => Boolean(
      await this.db.orderChatMessage.findUnique({ where: { imageKey: key }, select: { id: true } }),
    ));
  }
}
