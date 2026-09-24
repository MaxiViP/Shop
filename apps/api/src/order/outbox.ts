import type { NotificationType, Prisma } from '../db/gen/client.js';

// Persist on the business transaction connection; never call a provider here.
export function telegramEvent(
  db: Prisma.TransactionClient,
  data: {
    orderId: number;
    type: NotificationType;
    dedupeKey: string;
    issueId?: number;
    issueVersion?: number;
    messageId?: number;
  },
) {
  return db.orderNotification.upsert({
    where: { channel_dedupeKey: { channel: 'TELEGRAM', dedupeKey: data.dedupeKey } },
    create: { ...data, channel: 'TELEGRAM' },
    update: {},
  });
}
