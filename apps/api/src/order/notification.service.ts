import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { CustomerNotificationService } from '../telegram/customer-notification.service.js';
import type { BotDelivery } from '../telegram/bot-api.js';

// A real provider adapter must explicitly implement this contract. OTP is unrelated.
export abstract class OrderSmsProvider {
  abstract readonly available: boolean;
  abstract send(phone: string, text: string): Promise<void>;
}
@Injectable()
export class DisabledOrderSms extends OrderSmsProvider {
  readonly available = false;
  async send(): Promise<void> {
    throw new Error('SMS_UNCONFIGURED');
  }
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly logger = new Logger(NotificationService.name);
  constructor(
    private readonly db: DbService,
    private readonly sms: OrderSmsProvider,
    private readonly telegram: CustomerNotificationService,
  ) {}
  get available() {
    return process.env.ORDER_SMS_ENABLED === 'true' && this.sms.available;
  }

  // Preserve the existing SMS request/retry behavior. Telegram is delivered by the
  // durable pending-row sweep so slow sendMessage cannot time out a committed HTTP mutation.
  async dispatch(orderId: number) {
    await this.dispatchSms(orderId);
  }

  private async dispatchSms(orderId: number) {
    try {
      const events = await this.db.orderNotification.findMany({
        where: { orderId, channel: 'SMS', status: 'PENDING' },
        orderBy: { id: 'asc' },
        take: 50,
      });
      for (const event of events) {
        const current = await this.db.$transaction(async (db) => {
          await db.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
          const order = await db.order.findUniqueOrThrow({
            where: { id: orderId },
            include: { payment: true },
          });
          const issue = event.issueId
            ? await db.orderIssue.findUnique({ where: { id: event.issueId } })
            : null;
          const valid =
            order.status !== 'CANCELED' &&
            (event.type === 'ACTION_REQUIRED'
              ? issue?.status === 'WAITING_CUSTOMER' &&
                issue.version === event.issueVersion
              : order.status === 'READY' &&
                order.payment?.status === 'AWAITING');
          const result = await db.orderNotification.updateMany({
            where: { id: event.id, channel: 'SMS', status: 'PENDING' },
            data: {
              status: !valid
                ? 'CANCELED'
                : !this.available
                  ? 'UNCONFIGURED'
                  : 'SENDING',
              ...(valid && this.available
                ? { attempts: { increment: 1 } }
                : {}),
            },
          });
          return result.count && valid && this.available ? order : null;
        });
        if (!current) continue;
        try {
          // The URL contains no guest credential. Existing ownership/login remains required.
          const origin = process.env.ORDER_SITE_URL;
          if (!origin || new URL(origin).protocol !== 'https:')
            throw new Error('CONFIG');
          const url = new URL(`/order/${current.publicId}`, origin).href;
          await this.sms.send(
            current.customerPhone,
            event.type === 'ACTION_REQUIRED'
              ? `По заказу №${orderId} требуется ваше решение. Откройте заказ: ${url}`
              : `Заказ №${orderId} собран. Откройте заказ для оплаты: ${url}`,
          );
        } catch {
          // Never persist provider responses, keys, requisites or customer data in errors.
          await this.db.orderNotification.update({
            where: { id: event.id },
            data: { status: 'FAILED', error: 'SMS_SEND_FAILED' },
          });
          continue;
        }
        // If persisting success fails, leave SENDING (unknown outcome), not a false FAILED/retry.
        await this.db.orderNotification.update({
          where: { id: event.id },
          data: { status: 'SENT', sentAt: new Date(), error: null },
        });
      }
    } catch {
      this.logger.warn('Не удалось обработать уведомление заказа');
    }
  }

  async dispatchTelegram(orderId: number) {
    try {
      const events = await this.db.orderNotification.findMany({
        where: { orderId, channel: 'TELEGRAM', status: 'PENDING' },
        orderBy: { id: 'asc' }, take: 50,
      });
      for (const event of events) {
        const current = await this.db.$transaction(async db => {
          await db.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
          const order = await db.order.findUniqueOrThrow({
            where: { id: orderId },
            include: { payment: true, delivery: true, user: { select: { telegramIdentity: {
              select: { id: true, telegramUserId: true, customerBotStartedAt: true, customerBotBlockedAt: true },
            } } } },
          });
          const issue = event.issueId ? await db.orderIssue.findFirst({
            where: { id: event.issueId, orderId },
          }) : null;
          const message = event.messageId ? await db.orderChatMessage.findFirst({
            where: { id: event.messageId, orderId,
              // Lifecycle notices contain static text, not chat contents. A customer
              // cancellation keeps its original staff-only unread recipient.
              ...(event.type === 'CHAT_MESSAGE' ? { recipient: { in: ['customer', 'both'] } } : {}),
            },
          }) : null;
          let valid: boolean;
          switch (event.type) {
            case 'ACTION_REQUIRED':
              valid = order.status === 'ASSEMBLING' && !order.assemblyFinalizedAt &&
                !['PAID', 'REPORTED'].includes(order.payment?.status ?? '') &&
                issue?.status === 'WAITING_CUSTOMER' && issue.version === event.issueVersion;
              break;
            case 'PAYMENT_READY': valid = order.status === 'READY' && order.payment?.status === 'AWAITING'; break;
            case 'ORDER_CONFIRMED': valid = order.status === 'CONFIRMED'; break;
            case 'ASSEMBLY_STARTED': valid = order.status === 'ASSEMBLING'; break;
            case 'PAYMENT_RECEIVED': valid = order.payment?.status === 'PAID' && order.status !== 'CANCELED'; break;
            case 'ORDER_COMPLETED': valid = order.status === 'COMPLETED'; break;
            case 'ORDER_CANCELED': valid = order.status === 'CANCELED'; break;
            case 'CHAT_MESSAGE':
              valid = Boolean(message && ['SELLER', 'ADMIN', 'SYSTEM'].includes(message.authorType) &&
                message.id > order.customerReadMessageId);
              break;
            case 'DELIVERY_CHANGED':
              valid = Boolean(order.delivery && !['CANCELED', 'COMPLETED'].includes(order.status));
              break;
          }
          // Returning to ASSEMBLING must not revive a pending notice from an earlier cycle.
          if (valid && (event.type === 'ASSEMBLY_STARTED' || event.type === 'DELIVERY_CHANGED')) {
            const latest = await db.orderNotification.findFirst({
              where: { orderId, channel: 'TELEGRAM', type: event.type }, orderBy: { id: 'desc' }, select: { id: true },
            });
            valid = latest?.id === event.id;
          }
          if (event.type !== 'ACTION_REQUIRED' && event.type !== 'PAYMENT_READY') valid = valid && Boolean(message);
          const identity = order.user?.telegramIdentity;
          const eligible = this.telegram.available && identity?.customerBotStartedAt && !identity.customerBotBlockedAt;
          const claimed = await db.orderNotification.updateMany({
            where: { id: event.id, channel: 'TELEGRAM', status: 'PENDING' },
            data: {
              status: !valid ? 'CANCELED' : !eligible ? 'UNCONFIGURED' : 'SENDING',
              ...(valid && eligible ? { attempts: { increment: 1 } } : {}),
            },
          });
          return claimed.count && valid && eligible && identity ? { order, issue, message, identity } : null;
        });
        if (!current) continue;
        let outcome: BotDelivery;
        try {
          outcome = await this.telegram.send(current.identity.telegramUserId.toString(), {
            event, order: current.order, issue: current.issue, message: current.message,
          });
        } catch { outcome = 'unknown'; }
        // SENDING is deliberately terminal for automatic delivery after an uncertain outcome.
        // A crash after send or before recording success must never cause a blind resend.
        await this.db.orderNotification.update({
          where: { id: event.id },
          data: outcome === 'sent' ? { status: 'SENT', sentAt: new Date(), error: null } :
            outcome === 'unknown' ? { status: 'SENDING', error: 'TELEGRAM_OUTCOME_UNKNOWN' } :
              { status: 'FAILED', error: outcome === 'blocked' ? 'TELEGRAM_BLOCKED' : 'TELEGRAM_REJECTED' },
        });
        if (outcome === 'blocked') await this.db.telegramIdentity.updateMany({
          where: { id: current.identity.id, customerBotStartedAt: { lte: current.identity.customerBotStartedAt! } },
          data: { customerBotBlockedAt: new Date() },
        });
      }
    } catch { this.logger.warn('Customer notification dispatch failed'); }
  }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.sweep(); }, 30000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Resume only never-attempted Telegram work. SMS/manual retry behavior is unchanged.
      const rows = await this.db.orderNotification.findMany({
        where: { channel: 'TELEGRAM', status: 'PENDING' }, orderBy: { id: 'asc' },
        take: 50, select: { orderId: true },
      });
      for (const orderId of new Set(rows.map(row => row.orderId))) await this.dispatchTelegram(orderId);
      const expired = await this.db.customerTelegramSession.findMany({
        where: { expiresAt: { lte: new Date() } }, orderBy: { expiresAt: 'asc' }, take: 100, select: { id: true },
      });
      if (expired.length) await this.db.customerTelegramSession.deleteMany({ where: {
        id: { in: expired.map(row => row.id) }, expiresAt: { lte: new Date() },
      } });
    } catch { this.logger.warn('Customer notification sweep failed'); }
    finally { this.sweeping = false; }
  }
}
