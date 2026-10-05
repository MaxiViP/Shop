import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, UserRole } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { guestTokenHash } from '../common/guest.js';
import { OrderService } from './order.service.js';
import { compositionMoney } from './coordination.js';
import { orderChatPath } from '../telegram/chat-notice.js';
import { clip } from '../telegram/message.js';

const select = {
  id: true, type: true, audience: true, eventData: true, createdAt: true,
  order: { select: { id: true, publicId: true } },
  message: { select: { id: true, text: true, authorType: true, authorUserId: true, recipient: true, issueId: true } },
  imageRevision: { select: { actorUserId: true } },
  priceChange: { select: { actorId: true, previousPrice: true, newPrice: true,
    item: { select: { productName: true } } } },
} satisfies Prisma.OrderNotificationSelect;
type Event = Prisma.OrderNotificationGetPayload<{ select: typeof select }>;

export function inAppNotice(event: Event) {
  const staff = event.audience === 'STAFF';
  const order = event.order;
  const base = `${staff ? '/staff/orders/' : '/order/'}${staff ? order.id : order.publicId}`;
  let kind: string = event.type;
  let title = `Заказ №${order.id} обновлён`;
  let to = base;
  switch (event.type) {
    case 'CHAT_MESSAGE':
      title = event.message?.authorType === 'SYSTEM' ? clip(event.message.text, 150) : `Новое сообщение по заказу №${order.id}`;
      if (event.message?.authorType === 'SYSTEM') kind = event.message.issueId ? 'ORDER_ISSUE' : 'ORDER_UPDATED';
      to = orderChatPath(staff ? order.id : order.publicId, staff, event.message?.id);
      break;
    case 'CHAT_IMAGE_REVISION':
      title = `${staff ? 'Покупатель' : 'Продавец'} отметил фото · заказ №${order.id}`;
      to = orderChatPath(staff ? order.id : order.publicId, staff, event.message?.id);
      break;
    case 'ITEM_PRICE_CHANGED':
      if (event.priceChange) title = `${clip(event.priceChange.item.productName, 70)}: ${compositionMoney(event.priceChange.previousPrice)} → ${compositionMoney(event.priceChange.newPrice)} · заказ №${order.id}`;
      to += staff ? '#assembly' : '#order-items';
      break;
    case 'ACTION_REQUIRED': kind = 'ORDER_ISSUE'; title = `По заказу №${order.id} требуется ваше решение`; to += '#order-issues'; break;
    case 'PAYMENT_READY': kind = 'ORDER_READY'; title = `Заказ №${order.id} готов`; to += '#order-payment'; break;
    case 'ASSEMBLY_STARTED': title = `Заказ №${order.id} начали собирать`; break;
    case 'ORDER_CONFIRMED': kind = 'ORDER_STATUS_CHANGED'; title = `Заказ №${order.id} подтверждён`; break;
    case 'ORDER_COMPLETED': kind = 'ORDER_STATUS_CHANGED'; title = `Заказ №${order.id} завершён`; break;
    case 'ORDER_CANCELED': kind = 'ORDER_STATUS_CHANGED'; title = `Заказ №${order.id} отменён`; break;
    case 'ORDER_STATUS_CHANGED':
    case 'DELIVERY_CHANGED': kind = 'ORDER_STATUS_CHANGED'; title = event.message ? `Заказ №${order.id}: ${clip(event.message.text, 110)}` : title; break;
    case 'PAYMENT_RECEIVED': title = `Оплата заказа №${order.id} подтверждена`; to += '#order-payment'; break;
    case 'SCHEDULE_CHANGED': {
      const data = event.eventData;
      const at = data && typeof data === 'object' && !Array.isArray(data) ? data.scheduledFor : null;
      title = typeof at === 'string' ? `Заказ №${order.id} назначен на ${new Date(at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : `Заказ №${order.id} вернулся в очередь`;
      break;
    }
  }
  return { id: event.id, orderId: order.id, kind, title, to, createdAt: event.createdAt };
}

@Injectable()
export class InAppService {
  constructor(private readonly db: DbService, private readonly orders: OrderService) {}

  private async access(user: { id: number; role: UserRole } | null, guestToken?: string) {
    const customer = await this.orders.customerOrders(user?.id ?? null, guestToken);
    const scopes: Prisma.OrderNotificationWhereInput[] = [];
    if (customer) scopes.push({ audience: 'CUSTOMER', order: customer });
    if (user && ['SELLER', 'ADMIN'].includes(user.role)) scopes.push({ audience: 'STAFF', recipientUserId: user.id });
    return { where: { channel: 'IN_APP' as const, OR: scopes },
      scope: user ? `u:${user.id}:${user.role}` : customer ? `g:${guestTokenHash(String(customer.guestSessionId)).slice(0, 24)}` : null };
  }

  async list(user: { id: number; role: UserRole } | null, guestToken: string | undefined, limit: number) {
    const access = await this.access(user, guestToken);
    if (!access.scope) return { scope: null, events: [], hasMore: false };
    // Existing order/issue mutations cancel superseded deliveries in this same outbox.
    const rows = await this.db.orderNotification.findMany({ where: { ...access.where, seenAt: null, status: { not: 'CANCELED' } },
      select, orderBy: { id: 'asc' }, take: limit + 1 });
    const suppressed = rows.filter(row => {
      const data = row.eventData;
      const revision = row.type === 'CHAT_IMAGE_REVISION';
      const actor = revision ? row.imageRevision?.actorUserId : row.priceChange?.actorId ?? row.message?.authorUserId ??
        (data && typeof data === 'object' && !Array.isArray(data) ? data.actorUserId : null);
      return (user && actor === user.id) ||
        (!revision && row.audience === 'CUSTOMER' && (row.message?.authorType === 'CUSTOMER' || row.message?.recipient === 'staff'));
    });
    if (suppressed.length) await this.db.orderNotification.updateMany({
      where: { ...access.where, id: { in: suppressed.map(row => row.id) }, seenAt: null },
      data: { seenAt: new Date(), status: 'SENT' },
    });
    const visible = rows.filter(row => !suppressed.includes(row));
    return { scope: access.scope, events: visible.slice(0, limit).map(inAppNotice), hasMore: rows.length > limit };
  }

  async seen(user: { id: number; role: UserRole } | null, guestToken: string | undefined, ids: number[]) {
    const access = await this.access(user, guestToken);
    const unique = [...new Set(ids)];
    return this.db.$transaction(async db => {
      const found = await db.orderNotification.count({ where: { ...access.where, id: { in: unique } } });
      if (!access.scope || found !== unique.length) throw new NotFoundException('Уведомление не найдено');
      await db.orderNotification.updateMany({ where: { ...access.where, id: { in: unique }, seenAt: null },
        data: { seenAt: new Date(), status: 'SENT' } });
      return { seen: unique };
    });
  }
}
