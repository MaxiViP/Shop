import type { NotificationType, Prisma } from '../db/gen/client.js';

type OrderEvent = {
  orderId: number; type: NotificationType; dedupeKey: string;
  issueId?: number; issueVersion?: number; messageId?: number;
  imageRevisionId?: number; priceChangeId?: number;
  eventData?: Prisma.InputJsonObject;
};

// Channel fan-out stays on the business transaction, independent of Vue/Telegram transport.
export function inAppEvent(db: Prisma.TransactionClient, data: OrderEvent,
  recipientUserId?: number) {
  return db.orderNotification.upsert({
    where: { channel_dedupeKey: { channel: 'IN_APP', dedupeKey: data.dedupeKey } },
    create: { ...data, channel: 'IN_APP', audience: recipientUserId ? 'STAFF' : 'CUSTOMER', recipientUserId },
    update: { type: data.type, priceChangeId: data.priceChangeId, eventData: data.eventData },
  });
}

// Persist on the business transaction connection; never call a provider here.
export async function telegramEvent(
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
    eventData?: Prisma.InputJsonObject;
  },
) {
  const saved = await db.orderNotification.upsert({
    where: { channel_dedupeKey: { channel: 'TELEGRAM', dedupeKey: data.dedupeKey } },
    create: { ...data, channel: 'TELEGRAM' },
    update: {},
  });
  if (!['QUEUE_DELAY', 'ASSEMBLY_SOON'].includes(data.type)) await inAppEvent(db, data);
  return saved;
}

// The same transaction commits the chat mutation, unread state and one row per recipient.
export async function chatEvent(db: Prisma.TransactionClient, data: {
  orderId: number; messageId: number; actorType: 'CUSTOMER' | 'SELLER' | 'ADMIN';
  actorUserId: number | null; imageRevisionId?: number;
}) {
  const type = data.imageRevisionId ? 'CHAT_IMAGE_REVISION' : 'CHAT_MESSAGE';
  const key = data.imageRevisionId ? `revision:${data.messageId}:${data.imageRevisionId}` : `message:${data.messageId}`;
  if (data.actorType === 'CUSTOMER') {
    const staff = await db.user.findMany({ where: { role: { in: ['SELLER', 'ADMIN'] },
      ...(data.actorUserId ? { id: { not: data.actorUserId } } : {}) }, select: { id: true } });
    for (const recipient of staff) await inAppEvent(db, { orderId: data.orderId, messageId: data.messageId,
      imageRevisionId: data.imageRevisionId, type,
      dedupeKey: `${key}:staff:${recipient.id}` }, recipient.id);
  } else await inAppEvent(db, { orderId: data.orderId, messageId: data.messageId,
    imageRevisionId: data.imageRevisionId, type, dedupeKey: key,
    eventData: { actorUserId: data.actorUserId } });
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
