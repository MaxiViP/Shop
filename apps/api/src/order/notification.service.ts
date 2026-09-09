import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

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
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  constructor(
    private readonly db: DbService,
    private readonly sms: OrderSmsProvider,
  ) {}
  get available() {
    return process.env.ORDER_SMS_ENABLED === 'true' && this.sms.available;
  }

  // Called only after commit. Provider failures never roll back an order decision.
  async dispatch(orderId: number) {
    try {
      const events = await this.db.orderNotification.findMany({
        where: { orderId, status: 'PENDING' },
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
            where: { id: event.id, status: 'PENDING' },
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
}
