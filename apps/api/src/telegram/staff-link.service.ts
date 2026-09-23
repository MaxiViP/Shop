import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from '../db/db.service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const codePattern = /^[A-Za-z0-9_-]{22}$/;

@Injectable()
export class StaffLinkService {
  constructor(private readonly db: DbService) {}

  async createCode(userId: number): Promise<{ code: string; expiresAt: Date }> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || !['SELLER', 'ADMIN'].includes(user.role)) throw new ConflictException('Нет доступа');
    const code = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.db.staffTelegramLinkCode.upsert({
      where: { userId },
      create: { userId, codeHash: hash(code), expiresAt },
      update: { codeHash: hash(code), expiresAt },
    });
    return { code, expiresAt };
  }

  async link(telegramUserId: number, code: string): Promise<boolean> {
    if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !codePattern.test(code))
      return false;
    try {
      return await this.db.$transaction(async db => {
        const codeHash = hash(code);
        const entry = await db.staffTelegramLinkCode.findUnique({
          where: { codeHash },
          select: { userId: true, expiresAt: true, user: { select: { role: true } } },
        });
        if (!entry || entry.expiresAt <= new Date() || !['SELLER', 'ADMIN'].includes(entry.user.role))
          return false;
        const claimed = await db.staffTelegramLinkCode.deleteMany({
          where: { codeHash, expiresAt: { gt: new Date() } },
        });
        if (claimed.count !== 1) return false;
        const existing = await db.staffTelegramIdentity.findUnique({
          where: { telegramUserId: BigInt(telegramUserId) },
          select: { userId: true },
        });
        if (existing && existing.userId !== entry.userId) return false;
        await db.staffTelegramIdentity.upsert({
          where: { telegramUserId: BigInt(telegramUserId) },
          create: { telegramUserId: BigInt(telegramUserId), userId: entry.userId, botStartedAt: new Date() },
          update: { botStartedAt: new Date(), blockedAt: null },
        });
        return true;
      });
    } catch {
      // Unique constraints prevent both cross-account linking and concurrent code reuse.
      return false;
    }
  }
}
