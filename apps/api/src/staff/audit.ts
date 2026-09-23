import { ForbiddenException } from '@nestjs/common';
import type { Prisma, UserRole } from '../db/gen/client.js';

export type StaffActor = { userId: number; role: 'SELLER' | 'ADMIN' };

export function staffActor(user: { id: number; role: UserRole }): StaffActor {
  if (user.role !== 'SELLER' && user.role !== 'ADMIN') throw new ForbiddenException('??? ???????');
  return { userId: user.id, role: user.role };
}
export function assertStaffActor(actor: StaffActor | undefined, userId: number | null, role?: UserRole): void {
  if (actor && (actor.userId !== userId || (role && actor.role !== role)))
    throw new ForbiddenException('??? ???????');
}

export type StaffAuditAction =
  | 'CONFIRM' | 'START_ASSEMBLY' | 'ITEM_PICKED' | 'ITEM_MISSING' | 'ITEM_RESET'
  | 'EXTRA_ADD' | 'EXTRA_EDIT' | 'EXTRA_CANCEL' | 'FINISH_ASSEMBLY' | 'REOPEN'
  | 'PAYMENT_CONFIRM' | 'CANCEL' | 'RESTORE' | 'PICKUP_COMPLETE'
  | 'DELIVERY_UPDATE' | 'DELIVERY_HANDOFF' | 'DELIVERY_COMPLETE';

// Called inside the same transaction as the mutation. Role is read from the DB,
// so a revoked seller cannot rely on a stale cookie or Telegram callback.
export async function recordStaffAudit(db: Prisma.TransactionClient, orderId: number,
  actor: StaffActor | undefined, action: StaffAuditAction,
  entityType?: 'ITEM' | 'EXTRA' | 'DELIVERY', entityId?: number): Promise<void> {
  if (!actor) return; // Legacy internal callers have no authenticated staff actor.
  const rows = await db.$queryRaw<{ role: UserRole }[]>`
    SELECT "role" FROM "User" WHERE "id" = ${actor.userId} FOR SHARE
  `;
  const role = rows[0]?.role;
  if ((role !== 'SELLER' && role !== 'ADMIN') || role !== actor.role)
    throw new ForbiddenException('Нет доступа');
  await db.orderStaffAudit.create({ data: {
    orderId, userId: actor.userId, role, action, entityType, entityId,
  } });
}
