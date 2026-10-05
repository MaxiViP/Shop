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
    imageRevisionId?: number;
    recipientUserId?: number;
  },
) {
  return db.orderNotification.upsert({
    where: { channel_dedupeKey: { channel: 'TELEGRAM', dedupeKey: data.dedupeKey } },
    create: { ...data, channel: 'TELEGRAM' },
    update: {},
  });
}

// The same transaction commits the chat mutation, unread state and one row per recipient.
export async function chatEvent(db: Prisma.TransactionClient, data: {
  orderId: number; messageId: number; actorType: 'CUSTOMER' | 'SELLER' | 'ADMIN';
  actorUserId: number | null; imageRevisionId?: number;
}) {
  const type = data.imageRevisionId ? 'CHAT_IMAGE_REVISION' : 'CHAT_MESSAGE';
  const key = data.imageRevisionId ? `revision:${data.messageId}:${data.imageRevisionId}` : `message:${data.messageId}`;
  const recipients = data.actorType === 'CUSTOMER'
    ? await db.user.findMany({ where: { role: { in: ['SELLER', 'ADMIN'] },
      ...(data.actorUserId ? { id: { not: data.actorUserId } } : {}),
      staffTelegramIdentity: { is: { botStartedAt: { not: null }, blockedAt: null } },
    }, select: { id: true } })
    : await db.order.findUniqueOrThrow({ where: { id: data.orderId }, select: { userId: true } })
      .then(order => order.userId && order.userId !== data.actorUserId ? [{ id: order.userId }] : []);
  const channel = data.actorType === 'CUSTOMER' ? 'STAFF_TELEGRAM' : 'TELEGRAM';
  for (const recipient of recipients) {
    const dedupeKey = `${key}:recipient:${recipient.id}`;
    await db.orderNotification.upsert({
      where: { channel_dedupeKey: { channel, dedupeKey } }, update: {},
      create: { orderId: data.orderId, messageId: data.messageId,
        imageRevisionId: data.imageRevisionId, recipientUserId: recipient.id, type, channel, dedupeKey },
    });
  }
}
