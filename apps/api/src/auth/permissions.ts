import { ForbiddenException } from '@nestjs/common';
import type { Prisma, UserRole } from '../db/gen/client.js';

export const ownershipSelect = { ownedPoints: { select: { marketPointId: true } } } as const;
export type StaffUser = { role: UserRole; ownedPoints?: readonly { marketPointId: number }[] };
export function isStaff(user: StaffUser) {
  return user.role === 'ADMIN' || user.role === 'SELLER' || !!user.ownedPoints?.length;
}
export const staffWhere = {
  OR: [{ role: { in: ['SELLER', 'ADMIN'] } }, { ownedPoints: { some: {} } }],
} satisfies Prisma.UserWhereInput;
export function ownerProductWhere(userId: number) {
  return { marketPoint: { owners: { some: { userId } } } } satisfies Prisma.ProductWhereInput;
}
// Permission writers lock the same user row, so revocation cannot race a mutation.
export async function lockOwner(db: Prisma.TransactionClient, userId: number) {
  await db.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
  const count = await db.marketPointOwner.count({ where: { userId } });
  if (!count) throw new ForbiddenException('Нет доступа к товарам точки');
}
