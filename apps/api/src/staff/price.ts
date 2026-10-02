import type { Prisma } from '../db/gen/client.js';
import { adminPhone } from '../auth/admin.config.js';

// The configured primary ADMIN is bootstrapped into this role by AuthService.
// Keep all active linked ADMIN recipients so another admin can be added later.
export async function adminPriceRecipients(db: Prisma.TransactionClient): Promise<number[]> {
  const primary = adminPhone();
  const users = await db.user.findMany({
    where: { role: 'ADMIN', staffTelegramIdentity: {
      is: { botStartedAt: { not: null }, blockedAt: null },
    } },
    select: { id: true, phone: true },
  });
  return users.sort((a, b) => Number(b.phone === primary) - Number(a.phone === primary))
    .map(user => user.id);
}
