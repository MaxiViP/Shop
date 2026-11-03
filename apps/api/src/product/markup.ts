import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { effectivePercent } from './pricing.js';

// Pin the policy before its first read, including insert paths without an existing product row.
// Global changes use a conflicting table lock; ordinary reads remain available.
export async function lockMarkup(db: Prisma.TransactionClient, actorId?: number) {
  await db.$executeRaw`LOCK TABLE "Product" IN ROW EXCLUSIVE MODE`;
  if (actorId) await db.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId} FOR SHARE`;
}

export async function productMarkup(db: Prisma.TransactionClient, override: number | null) {
  const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 },
    select: { globalServiceMarkupPercent: true } });
  return { serviceMarkupPercentOverride: override,
    serviceMarkupPercent: effectivePercent(override, settings.globalServiceMarkupPercent) };
}

// Never guess whether an old independent effective-field edit was intentional.
export function assertMarkup(product: { serviceMarkupPercentOverride: number | null; serviceMarkupPercent: number }) {
  if (product.serviceMarkupPercentOverride !== null && product.serviceMarkupPercent !== product.serviceMarkupPercentOverride)
    throw new ConflictException('Проверьте прежний индивидуальный процент перед изменением товара.');
}
