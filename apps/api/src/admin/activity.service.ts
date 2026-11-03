import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';
import { adminPhone } from '../auth/admin.config.js';
import { botExchange } from '../telegram/bot-api.js';
import { staffBotToken } from '../telegram/bot-config.js';
import { activityText } from './activity-format.js';

@Injectable()
export class AdminActivityService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(AdminActivityService.name);
  constructor(private readonly db: DbService) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.warn('Admin change notification processing failed'),
      );
    }, 5000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async assertPrimary(actorId: number) {
    const primary = adminPhone();
    const user = await this.db.user.findUnique({
      where: { id: actorId },
      select: { phone: true, role: true },
    });
    if (!primary || user?.role !== 'ADMIN' || user.phone !== primary)
      throw new ForbiddenException('Только основной администратор');
  }
  private async recipient() {
    const phone = adminPhone();
    if (!phone || !staffBotToken()) return null;
    const user = await this.db.user.findUnique({
      where: { phone },
      select: {
        role: true,
        staffTelegramIdentity: {
          select: { telegramUserId: true, botStartedAt: true, blockedAt: true },
        },
      },
    });
    const identity = user?.staffTelegramIdentity;
    if (user?.role !== 'ADMIN' || !identity?.botStartedAt || identity.blockedAt)
      return null;
    const chatId = Number(identity.telegramUserId);
    return Number.isSafeInteger(chatId) && chatId > 0 ? chatId : null;
  }
  async list(actorId: number, page: number) {
    await this.assertPrimary(actorId);
    const [items, total] = await this.db.$transaction([
      this.db.adminChange.findMany({
        where: { notifyOwner: true },
        orderBy: { id: 'desc' },
        skip: (page - 1) * 30,
        take: 30,
      }),
      this.db.adminChange.count({ where: { notifyOwner: true } }),
    ]);
    return {
      items: items.map(({ txId: _txId, ...item }) => item),
      total,
      page,
      pages: Math.ceil(total / 30),
      deliveryReady: Boolean(await this.recipient()),
    };
  }
  async retry(actorId: number, id: number) {
    await this.assertPrimary(actorId);
    const item = await this.db.adminChange.findUniqueOrThrow({
      where: { id },
      select: { requestId: true },
    });
    await this.db.adminChange.updateMany({
      where: {
        requestId: item.requestId,
        notifyOwner: true,
        status: { in: ['UNKNOWN', 'FAILED'] },
      },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        claimToken: null,
        leaseUntil: null,
        attempts: 0,
      },
    });
    return { ok: true };
  }
  async test(actorId: number) {
    await this.assertPrimary(actorId);
    const chatId = await this.recipient();
    if (!chatId)
      throw new BadRequestException(
        'Подключите Telegram основного администратора в кабинете сотрудника',
      );
    const outcome = await botExchange(staffBotToken(), 'sendMessage', {
      chat_id: chatId,
      text: 'Проверка уведомлений KorzinaMarket.\nСюда будут приходить сообщения об изменениях других администраторов. Ваши собственные действия не вызывают уведомлений.',
    });
    return { status: outcome.status };
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // An expired send may already have reached Telegram. Retain it for an
      // explicit owner retry instead of automatically sending a duplicate.
      await this.db.adminChange.updateMany({
        where: { status: 'SENDING', leaseUntil: { lt: new Date() } },
        data: { status: 'UNKNOWN', claimToken: null, leaseUntil: null },
      });
      const chatId = await this.recipient();
      if (!chatId) return;
      const token = randomUUID();
      const events = await this.db.$transaction(async (db) => {
        const candidates = await db.$queryRaw<
          { id: number; requestId: string }[]
        >`
          SELECT id,"requestId" FROM "AdminChange" WHERE "notifyOwner"=true AND status='PENDING' AND "nextAttemptAt"<=CURRENT_TIMESTAMP
            AND "createdAt"<CURRENT_TIMESTAMP-interval '3 seconds' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const first = candidates[0];
        if (!first) return [];
        const locked = await db.$queryRaw<{ id: number }[]>`
          SELECT id FROM "AdminChange" WHERE "notifyOwner"=true AND "requestId"=${first.requestId}::uuid AND status='PENDING'
            AND "nextAttemptAt"<=CURRENT_TIMESTAMP ORDER BY id LIMIT 30 FOR UPDATE SKIP LOCKED`;
        const rows = await db.adminChange.findMany({
          where: { id: { in: locked.map((row) => row.id) } },
          orderBy: { id: 'asc' },
        });
        await db.adminChange.updateMany({
          where: { id: { in: rows.map((x) => x.id) }, status: 'PENDING' },
          data: {
            status: 'SENDING',
            claimToken: token,
            leaseUntil: new Date(Date.now() + 60000),
            attempts: { increment: 1 },
          },
        });
        return rows;
      });
      if (!events.length) return;
      const outcome = await botExchange(staffBotToken(), 'sendMessage', {
        chat_id: chatId,
        text: activityText(events),
        link_preview_options: { is_disabled: true },
      });
      const attempts = Math.max(...events.map((x) => x.attempts)) + 1;
      const status =
        outcome.status === 'sent'
          ? 'SENT'
          : outcome.status === 'retryable' && attempts < 5
            ? 'PENDING'
            : outcome.status === 'unknown'
              ? 'UNKNOWN'
              : 'FAILED';
      await this.db.adminChange.updateMany({
        where: { claimToken: token, status: 'SENDING' },
        data: {
          status,
          claimToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + 60000),
          sentAt: status === 'SENT' ? new Date() : null,
        },
      });
    } finally {
      this.busy = false;
    }
  }
}
