import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import type { z } from 'zod';
import { DbService } from '../db/db.service.js';
import { OrderService } from './order.service.js';
import { NotificationService } from './notification.service.js';
import { actionNotification, message, customerIssueActions } from './coordination.js';
import { cancelOrder } from './cancel.js';
import { goodsLine } from './pricing.js';
import { chatSchema } from './coordination.schema.js';
import type {
  cursorSchema,
  decisionSchema,
  proposalSchema,
} from './coordination.schema.js';

export type OrderActor =
  | { publicId: string; userId: number | null; guestToken?: string }
  | { orderId: number; userId: number; role: 'SELLER' | 'ADMIN' };
const stale = () =>
  new ConflictException('Данные позиции изменились. Обновите заказ.');

@Injectable()
export class CoordinationService {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderService,
    private readonly notifications: NotificationService,
  ) {}

  private async locked<T>(
    actor: OrderActor,
    fn: (db: Prisma.TransactionClient, id: number) => Promise<T>,
  ) {
    // Resolve/expire the guest session before taking an Order lock. Ownership is
    // checked again on the transaction connection, not through a second connection.
    const access =
      'publicId' in actor
        ? await this.orders.access(
            actor.publicId,
            actor.userId,
            actor.guestToken,
          )
        : null;
    return this.db.$transaction(async (db) => {
      if ('orderId' in actor) {
        const rows = await db.$queryRaw<
          { id: number }[]
        >`SELECT id FROM "Order" WHERE id = ${actor.orderId} FOR UPDATE`;
        if (!rows.length) throw new NotFoundException('Заказ не найден');
        return fn(db, actor.orderId);
      }
      await db.$queryRaw`SELECT id FROM "Order" WHERE "publicId" = ${actor.publicId}::uuid FOR UPDATE`;
      if (!access) throw new NotFoundException('Заказ не найден');
      const order = await db.order.findFirst({
        where: access,
        select: { id: true },
      });
      if (!order) throw new NotFoundException('Заказ не найден');
      return fn(db, order.id);
    });
  }

  private async assembling(db: Prisma.TransactionClient, id: number) {
    const order = await db.order.findUniqueOrThrow({
      where: { id },
      include: { payment: true },
    });
    if (
      order.status !== 'ASSEMBLING' ||
      order.assemblyFinalizedAt ||
      ['REPORTED', 'PAID'].includes(order.payment?.status ?? '')
    )
      throw new ConflictException('Согласование состава заказа уже недоступно');
    return order;
  }

  view(actor: OrderActor) {
    return this.locked(actor, async (db, id) => {
      // A transaction has one PostgreSQL connection; do not run concurrent queries on it.
      const issues = await db.orderIssue.findMany({
        where: { orderId: id },
        orderBy: { id: 'asc' },
        include: {
          orderItem: {
            select: {
              productName: true,
              unit: true,
              price: true,
              priceQty: true,
            },
          },
        },
      });
      const settings = await db.shopSettings.findUniqueOrThrow({
        where: { id: 1 },
      });
      const order = await db.order.findUniqueOrThrow({
        where: { id },
        select: {
          status: true, assemblyFinalizedAt: true, payment: { select: { status: true } },
          customerUnread: true,
          staffUnread: true,
          customerReadMessageId: true,
          staffReadMessageId: true,
        },
      });
      const events =
        'orderId' in actor
          ? await db.orderNotification.findMany({
              where: { orderId: id, channel: 'SMS' },
              orderBy: { id: 'desc' },
              take: 20,
              select: {
                id: true,
                issueId: true,
                type: true,
                status: true,
                sentAt: true,
                createdAt: true,
                error: true,
              },
            })
          : [];
      return {
        issues: issues.map(issue => ({ ...issue, actions: order.status === 'ASSEMBLING' &&
          !order.assemblyFinalizedAt && !['PAID', 'REPORTED'].includes(order.payment?.status ?? '') ? customerIssueActions(issue) : [] })),
        responseMinutes: settings.customerResponseMinutes,
        unread: 'orderId' in actor ? order.staffUnread : order.customerUnread,
        readThrough:
          'orderId' in actor
            ? order.staffReadMessageId
            : order.customerReadMessageId,
        smsAvailable: 'orderId' in actor && this.notifications.available,
        notifications: events,
      };
    });
  }

  async decide(
    actor: OrderActor,
    issueId: number,
    data: z.infer<typeof decisionSchema>,
  ) {
    const result = await this.locked(actor, async (db, id) => {
      const issue = await db.orderIssue.findFirst({
        where: { id: issueId, orderId: id },
        include: { orderItem: true },
      });
      if (!issue) throw new NotFoundException('Проблема не найдена');
      if (issue.version !== data.version) throw stale();
      // Retries acknowledge only the identical decision for the identical version.
      if (
        issue.resolution === data.action &&
        ['RESOLVED', 'WAITING_SELLER', 'CANCELED'].includes(issue.status)
      )
        return issue;
      await this.assembling(db, id);
      if (!customerIssueActions(issue).includes(data.action)) throw stale();
      if (data.action === 'CANCEL_ORDER') {
        await cancelOrder(db, id, actor.userId, 'USER');
        return db.orderIssue.findUniqueOrThrow({ where: { id: issue.id } });
      }
      if (
        ['ACCEPT_ACTUAL', 'REQUEST_REDUCE'].includes(data.action) &&
        (issue.type !== 'WEIGHT_DEVIATION' ||
          issue.actualQty !== issue.orderItem.actualQty ||
          issue.orderItem.status !== 'PICKED')
      )
        throw stale();
      let replacementItemId: number | undefined;
      if (
        data.action === 'REMOVE_ITEM' ||
        data.action === 'ACCEPT_REPLACEMENT'
      ) {
        await db.orderItem.update({
          where: { id: issue.orderItemId },
          data: { status: 'MISSING', actualQty: 0, actualTotal: 0 },
        });
      }
      if (data.action === 'ACCEPT_REPLACEMENT') {
        if (
          issue.type !== 'REPLACEMENT' ||
          !issue.proposedName ||
          !issue.proposedSlug ||
          !issue.proposedUnit ||
          !issue.proposedPrice ||
          !issue.proposedPriceQty ||
          !issue.proposedQty
        )
          throw stale();
        const replacement = await db.orderItem.create({
          data: {
            orderId: id,
            productId: issue.proposedProductId,
            productName: issue.proposedName,
            productSlug: issue.proposedSlug,
            unit: issue.proposedUnit,
            price: issue.proposedPrice,
            priceQty: issue.proposedPriceQty,
            qty: issue.proposedQty,
            image: issue.proposedImageUrl,
            total: goodsLine(
              issue.proposedPrice,
              issue.proposedQty,
              issue.proposedPriceQty,
            ),
          },
        });
        replacementItemId = replacement.id;
      }
      const updated = await db.orderIssue.update({
        where: { id: issue.id },
        data: {
          status:
            data.action === 'REQUEST_REDUCE' ? 'WAITING_SELLER' : 'RESOLVED',
          resolution: data.action,
          resolvedAt: data.action === 'REQUEST_REDUCE' ? null : new Date(),
          approvedActualQty:
            data.action === 'ACCEPT_ACTUAL' ? issue.actualQty : null,
          replacementItemId,
        },
      });
      const text =
        data.action === 'ACCEPT_ACTUAL'
          ? `Покупатель согласился на ${issue.actualQty} г: ${issue.orderItem.productName}.`
          : data.action === 'REQUEST_REDUCE'
            ? `Покупатель попросил уменьшить вес: ${issue.orderItem.productName}.`
            : data.action === 'ACCEPT_REPLACEMENT'
              ? `Покупатель выбрал замену: ${issue.proposedName}.`
              : `Покупатель убрал из заказа: ${issue.orderItem.productName}.`;
      await message(db, id, text, 'SYSTEM', actor.userId, issue.id, 'staff');
      await db.orderNotification.updateMany({
        where: {
          issueId: issue.id,
          status: { in: ['PENDING', 'UNCONFIGURED', 'FAILED'] },
        },
        data: { status: 'CANCELED' },
      });
      return updated;
    });
    await this.notifications.dispatch(result.orderId);
    return result;
  }

  async propose(
    actor: OrderActor,
    issueId: number,
    data: z.infer<typeof proposalSchema>,
  ) {
    const result = await this.locked(actor, async (db, id) => {
      await this.assembling(db, id);
      const issue = await db.orderIssue.findFirst({
        where: { id: issueId, orderId: id },
        include: { orderItem: true },
      });
      if (!issue) throw new NotFoundException('Проблема не найдена');
      if (
        issue.version !== data.version ||
        issue.orderItem.status !== 'MISSING' ||
        !['WAITING_CUSTOMER', 'WAITING_SELLER'].includes(issue.status)
      )
        throw stale();
      await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${data.productId} FOR UPDATE`;
      const product = await db.product.findFirst({
        where: { id: data.productId, active: true },
        include: {
          images: {
            where: { visible: true },
            orderBy: [{ sort: 'asc' }, { id: 'asc' }],
            take: 1,
          },
        },
      });
      if (
        !product ||
        data.qty < product.min ||
        (data.qty - product.min) % product.step !== 0
      )
        throw new BadRequestException(
          'Товар недоступен или количество не соответствует шагу продажи',
        );
      const total = goodsLine(product.price, data.qty, product.priceQty);
      const updated = await db.orderIssue.update({
        where: { id: issue.id },
        data: {
          type: 'REPLACEMENT',
          status: 'WAITING_CUSTOMER',
          version: { increment: 1 },
          resolution: null,
          resolvedAt: null,
          proposedProductId: product.id,
          proposedName: product.name,
          proposedSlug: product.slug,
          proposedPrice: product.price,
          proposedPriceQty: product.priceQty,
          proposedQty: data.qty,
          proposedUnit: product.unit,
          proposedImageUrl: product.images[0]?.url ?? null,
        },
      });
      await message(
        db,
        id,
        `Предложена замена: ${product.name}, количество ${data.qty} (${product.unit}), стоимость ${total} коп.`,
        'SYSTEM',
        actor.userId,
        issue.id,
        'customer',
      );
      await actionNotification(db, updated);
      return updated;
    });
    await this.notifications.dispatch(result.orderId);
    return result;
  }

  messages(actor: OrderActor, query: z.infer<typeof cursorSchema>) {
    return this.locked(actor, async (db, id) => {
      const rows = await db.orderChatMessage.findMany({
        where: {
          orderId: id,
          id: query.after
            ? { gt: query.after }
            : query.before
              ? { lt: query.before }
              : undefined,
        },
        orderBy: { id: query.after ? 'asc' : 'desc' },
        take: query.limit + 1,
        select: {
          id: true,
          issueId: true,
          authorType: true,
          text: true,
          createdAt: true,
        },
      });
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      return { messages: query.after ? page : page.reverse(), hasMore };
    });
  }

  // A reservation ID prevents delayed prompt delivery from reviving a canceled flow.
  reserveReply(actor: Extract<OrderActor, { publicId: string }>, identityId: number) {
    return this.locked(actor, async (db, id) => {
      if (!actor.userId) throw new NotFoundException('Заказ не найден');
      const rows = await db.$queryRaw<{ id: number }[]>`SELECT id FROM "TelegramIdentity" WHERE id = ${identityId} AND "userId" = ${actor.userId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Аккаунт недоступен');
      await db.customerTelegramSession.deleteMany({ where: { identityId } });
      return db.customerTelegramSession.create({ data: {
        identityId, orderId: id, action: 'CHAT', step: 'PROMPT',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } });
    });
  }

  async post(actor: OrderActor, text: string, reply?: { sessionId: string; identityId: number; promptMessageId: number }) {
    text = chatSchema.parse({ text }).text;
    const saved = await this.locked(actor, async (db, id) => {
      if (reply) {
        if ('orderId' in actor || !actor.userId) throw new NotFoundException('Ответ недоступен');
        const claimed = await db.customerTelegramSession.deleteMany({ where: {
          id: reply.sessionId, identityId: reply.identityId, identity: { userId: actor.userId },
          orderId: id, action: 'CHAT', step: 'TEXT', promptMessageId: reply.promptMessageId,
          expiresAt: { gt: new Date() },
        } });
        if (claimed.count !== 1) throw new ConflictException('Ожидание ответа завершено');
      }
      const staff = 'orderId' in actor;
      const recent = await db.orderChatMessage.count({
        where: {
          orderId: id,
          authorType: staff ? { in: ['SELLER', 'ADMIN'] } : 'CUSTOMER',
          createdAt: { gt: new Date(Date.now() - 60000) },
        },
      });
      if (recent >= 15)
        throw new HttpException(
          'Слишком много сообщений. Подождите минуту.',
          429,
        );
      return message(
        db,
        id,
        text,
        staff ? actor.role : 'CUSTOMER',
        actor.userId,
        null,
        staff ? 'customer' : 'staff',
      );
    });
    if ('orderId' in actor) await this.notifications.dispatch(saved.orderId);
    return saved;
  }

  read(actor: OrderActor, through: number) {
    return this.locked(actor, async (db, id) => {
      const staff = 'orderId' in actor;
      if (
        through &&
        !(await db.orderChatMessage.findFirst({
          where: { orderId: id, id: through },
        }))
      )
        throw new BadRequestException('Сообщение не найдено');
      const order = await db.order.findUniqueOrThrow({ where: { id } });
      const cursor = Math.max(
        through,
        staff ? order.staffReadMessageId : order.customerReadMessageId,
      );
      const unread = await db.orderChatMessage.count({
        where: {
          orderId: id,
          id: { gt: cursor },
          recipient: { in: [staff ? 'staff' : 'customer', 'both'] },
        },
      });
      await db.order.update({
        where: { id },
        data: staff
          ? { staffReadMessageId: cursor, staffUnread: unread }
          : { customerReadMessageId: cursor, customerUnread: unread },
      });
      return { unread };
    });
  }

  async retry(actor: OrderActor, issueId: number) {
    const id = await this.locked(actor, async (db, id) => {
      if (!this.notifications.available)
        throw new ConflictException('SMS не настроены. Позвоните покупателю.');
      const issue = await db.orderIssue.findFirst({
        where: { id: issueId, orderId: id, status: 'WAITING_CUSTOMER' },
      });
      if (!issue) throw stale();
      const event = await db.orderNotification.findUnique({
        where: { channel_dedupeKey: { channel: 'SMS', dedupeKey: `issue:${issue.id}:${issue.version}` } },
      });
      if (!event || event.status === 'SENDING')
        throw new ConflictException(
          'Отправка ещё не завершена; проверьте её результат перед повтором.',
        );
      if (Date.now() - event.updatedAt.getTime() < 60000)
        throw new HttpException(
          'Повторная отправка доступна через минуту',
          429,
        );
      await db.orderNotification.update({
        where: { id: event.id },
        data: { status: 'PENDING', error: null },
      });
      return id;
    });
    await this.notifications.dispatch(id);
    return { ok: true };
  }
}
