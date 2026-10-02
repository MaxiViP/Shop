import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  HttpException,
  GoneException,
  Logger,
} from '@nestjs/common';
import type { Prisma, OrderChatMessage, MessageAuthor } from '../db/gen/client.js';
import type { z } from 'zod';
import { DbService } from '../db/db.service.js';
import { OrderService } from './order.service.js';
import { NotificationService } from './notification.service.js';
import { actionNotification, chatUnread, message, customerIssueActions, compositionQty, compositionMoney } from './coordination.js';
import { cancelOrder } from './cancel.js';
import { goodsLine } from './pricing.js';
import { chatSchema } from './coordination.schema.js';
import { imageChatSchema, imageRevisionSchema } from './coordination.schema.js';
import { ChatImagesService } from './chat-images.service.js';
import type { ChatUploadFile } from './chat-images.service.js';
import { imageExpiry } from './chat-cleanup.service.js';
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
type ImageRevisionView = { version: number; caption: string; actorType: MessageAuthor; createdAt: Date };
const latestRevision = { orderBy: { version: 'desc' }, take: 1,
  select: { version: true, caption: true, actorType: true, createdAt: true } } as const;
function revisionFields(revision?: ImageRevisionView | null) {
  return { revisionText: revision?.version ? revision.caption : null,
    revisionActor: revision?.version ? revision.actorType : null,
    revisionAt: revision?.version ? revision.createdAt : null };
}
function publicChatMessage(saved: OrderChatMessage, revision?: ImageRevisionView | null) {
  return {
    id: saved.id, orderId: saved.orderId, issueId: saved.issueId,
    authorType: saved.authorType, authorUserId: saved.authorUserId,
    recipient: saved.recipient, text: saved.text, createdAt: saved.createdAt,
    image: Boolean(saved.imageKey || saved.imageDeletedAt), imageExpired: Boolean(saved.imageDeletedAt),
    imageRevision: saved.imageRevision, ...revisionFields(revision),
  };
}

@Injectable()
export class CoordinationService {
  private readonly logger = new Logger(CoordinationService.name);
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderService,
    private readonly notifications: NotificationService,
    private readonly images: ChatImagesService,
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
              actualPrice: true,
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
        status: order.status,
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
        if (!issue.proposedProductId) throw stale();
        await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${issue.proposedProductId} FOR SHARE`;
        const product = await db.product.findUnique({
          where: { id: issue.proposedProductId },
          select: { settlementMode: true, basePrice: true },
        });
        if (!product) throw stale();
        const replacement = await db.orderItem.create({
          data: {
            orderId: id,
            productId: issue.proposedProductId,
            settlementModeSnapshot: product.settlementMode,
            basePriceSnapshot: product.basePrice,
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
      const notice = await message(
        db,
        id,
        `Для товара «${issue.orderItem.productName}» предложена замена: ${product.name}, ${compositionQty(data.qty, product.unit)}, ${compositionMoney(total)}.`,
        'SYSTEM',
        actor.userId,
        issue.id,
        'customer',
      );
      await actionNotification(db, updated, notice.id);
      return updated;
    });
    void this.notifications.dispatchTelegram(result.orderId).catch(() => {});
    await this.notifications.dispatch(result.orderId);
    return result;
  }

  messages(actor: OrderActor, query: z.infer<typeof cursorSchema>) {
    return this.locked(actor, async (db, id) => {
      const seenIds = query.seen?.split(',').map(Number) ?? [];
      if (seenIds.length > 500 || seenIds.some(value => !Number.isSafeInteger(value) || value <= 0))
        throw new BadRequestException('Слишком много фото для обновления');
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
          imageKey: true,
          imageRevision: true,
          imageDeletedAt: true,
          createdAt: true,
          imageRevisions: latestRevision,
        },
      });
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const seen = seenIds.length ? await db.orderChatMessage.findMany({
        where: { orderId: id, id: { in: seenIds } },
        select: { id: true, imageRevision: true, imageDeletedAt: true,
          imageRevisions: latestRevision },
      }) : [];
      return {
        messages: (query.after ? page : page.reverse()).map(({ imageKey, imageDeletedAt, imageRevisions, ...entry }) => ({
          ...entry, image: Boolean(imageKey || imageDeletedAt), imageExpired: Boolean(imageDeletedAt),
          ...revisionFields(imageRevisions[0]),
        })),
        revisions: seen.map(row => ({ id: row.id, imageRevision: row.imageRevision,
          imageExpired: Boolean(row.imageDeletedAt), ...revisionFields(row.imageRevisions[0]) })),
        hasMore, orderId: id,
      };
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

  private saveChat(actor: OrderActor, text: string,
    reply?: { sessionId: string; identityId: number; promptMessageId: number },
    image?: { key: string; issueId?: number; evidence?: boolean; requestId?: string }) {
    text = image ? imageChatSchema.parse({ text }).text : chatSchema.parse({ text }).text;
    return this.locked(actor, async (db, id) => {
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
      const existing = image?.requestId
        ? await this.existingImage(db, id, actor, image.requestId) : null;
      if (existing) return existing;
      await this.assertChatRate(db, id, staff);
      const order = image ? await db.order.findUniqueOrThrow({
        where: { id }, include: { cancellations: {
          where: { restoredAt: null }, orderBy: { canceledAt: 'desc' }, take: 1,
        } },
      }) : null;
      const issue = image?.issueId ? await db.orderIssue.findFirst({
        where: { id: image.issueId, orderId: id },
      }) : null;
      if (image?.issueId && !issue) throw new BadRequestException('Проблема заказа не найдена');
      const retention = image && (issue || image.evidence || (!staff && order?.status === 'COMPLETED'))
        ? 'EVIDENCE' : 'OPERATIONAL';
      const now = new Date();
      return message(
        db,
        id,
        text,
        staff ? actor.role : 'CUSTOMER',
        actor.userId,
        issue?.id ?? null,
        staff ? 'customer' : 'staff',
        undefined,
        image && order ? { key: image.key, retention, expiresAt: imageExpiry({
          retention, createdAt: now, orderStatus: order.status,
          completedAt: order.completedAt, canceledAt: order.cancellations[0]?.canceledAt ?? null,
          orderUpdatedAt: order.updatedAt, issue,
        }), requestId: image.requestId } : undefined,
      );
    });
  }

  private async existingImage(db: Prisma.TransactionClient, id: number, actor: OrderActor, requestId: string) {
    const saved = await db.orderChatMessage.findUnique({
      where: { orderId_imageRequestId: { orderId: id, imageRequestId: requestId } },
    });
    if (!saved) return null;
    const staff = 'orderId' in actor;
    if (saved.authorUserId !== actor.userId ||
        (staff ? !['SELLER', 'ADMIN'].includes(saved.authorType) : saved.authorType !== 'CUSTOMER'))
      throw new ConflictException('Ключ отправки фото уже использован');
    return saved;
  }

  private async assertChatRate(db: Prisma.TransactionClient, id: number, staff: boolean) {
    const recent = await db.orderChatMessage.count({ where: {
      orderId: id,
      authorType: staff ? { in: ['SELLER', 'ADMIN'] } : 'CUSTOMER',
      createdAt: { gt: new Date(Date.now() - 60000) },
    } });
    if (recent >= 15)
      throw new HttpException('Слишком много сообщений. Подождите минуту.', 429);
  }

  private async notifyChat(actor: OrderActor, orderId: number) {
    if ('orderId' in actor) {
      // The chat message, unread count and TELEGRAM outbox row have committed.
      // The dispatcher claims PENDING atomically; the sweep remains a crash fallback.
      void this.notifications.dispatchTelegram(orderId).catch(() => {});
      await this.notifications.dispatch(orderId);
    }
  }

  async post(actor: OrderActor, text: string, reply?: { sessionId: string; identityId: number; promptMessageId: number }) {
    const saved = await this.saveChat(actor, text, reply);
    await this.notifyChat(actor, saved.orderId);
    return publicChatMessage(saved);
  }

  async postImage(actor: OrderActor, text: string, file?: ChatUploadFile, issueId?: number, evidence?: boolean, requestId?: string) {
    // The interceptor owns the staged file, including validation and DB failures.
    const duplicate = await this.locked(actor, async (db, id) => {
      const existing = requestId ? await this.existingImage(db, id, actor, requestId) : null;
      if (!existing) await this.assertChatRate(db, id, 'orderId' in actor);
      return existing;
    });
    if (duplicate) return publicChatMessage(duplicate);
    const imageKey = await this.images.save(file);
    let saved: Awaited<ReturnType<CoordinationService['saveChat']>>;
    try { saved = await this.saveChat(actor, text, undefined, { key: imageKey, issueId, evidence, requestId }); }
    catch (error) {
      await this.images.remove(imageKey).catch((cause: unknown) => this.logger.error('Could not remove unwritten chat image', cause));
      throw error;
    }
    if (saved.imageKey !== imageKey) {
      await this.images.remove(imageKey).catch((cause: unknown) => this.logger.error('Could not remove duplicate chat image', cause));
      return publicChatMessage(saved);
    }
    await this.notifyChat(actor, saved.orderId);
    return publicChatMessage(saved);
  }

  private async existingRevision(db: Prisma.TransactionClient, orderId: number, messageId: number,
    actor: OrderActor, data: z.infer<typeof imageRevisionSchema>) {
    const previous = await db.orderChatImageRevision.findUnique({
      where: { messageId_requestId: { messageId, requestId: data.requestId } },
    });
    if (!previous) return null;
    const staff = 'orderId' in actor;
    if (previous.actorUserId !== actor.userId || previous.caption !== data.text ||
      (staff ? !['SELLER', 'ADMIN'].includes(previous.actorType) : previous.actorType !== 'CUSTOMER'))
      throw new ConflictException('Ключ разметки уже использован');
    const row = await db.orderChatMessage.findFirst({
      where: { id: messageId, orderId }, include: { imageRevisions: latestRevision },
    });
    if (!row) throw new NotFoundException('Фото не найдено');
    return publicChatMessage(row, row.imageRevisions[0]);
  }

  async reviseImage(actor: OrderActor, messageId: number,
    input: z.infer<typeof imageRevisionSchema>, file?: ChatUploadFile) {
    const data = imageRevisionSchema.parse(input);
    const duplicate = await this.locked(actor, async (db, id) => {
      const row = await db.orderChatMessage.findFirst({ where: { id: messageId, orderId: id },
        select: { imageKey: true, imageDeletedAt: true } });
      if (!row) throw new NotFoundException('Фото не найдено');
      const earlier = await this.existingRevision(db, id, messageId, actor, data);
      if (earlier) return earlier;
      if (row.imageDeletedAt) throw new GoneException('Фото больше не хранится');
      if (!row.imageKey) throw new NotFoundException('Фото не найдено');
      return null;
    });
    if (duplicate) return duplicate;
    const imageKey = await this.images.save(file);
    let result: { message: ReturnType<typeof publicChatMessage>; used: boolean };
    try {
      result = await this.locked(actor, async (db, id) => {
        const earlier = await this.existingRevision(db, id, messageId, actor, data);
        if (earlier) return { message: earlier, used: false };
        const row = await db.orderChatMessage.findFirst({ where: { id: messageId, orderId: id },
          include: { imageRevisions: latestRevision, issue: true,
            order: { include: { cancellations: {
              where: { restoredAt: null }, orderBy: { canceledAt: 'desc' }, take: 1,
            } } } },
        });
        if (!row) throw new NotFoundException('Фото не найдено');
        if (row.imageDeletedAt) throw new GoneException('Фото больше не хранится');
        if (!row.imageKey) throw new NotFoundException('Фото не найдено');
        const latestAt = row.imageRevisions[0]?.createdAt ?? row.createdAt;
        const currentExpiry = imageExpiry({
          retention: row.imageRetention ?? 'OPERATIONAL', createdAt: latestAt,
          orderStatus: row.order.status, completedAt: row.order.completedAt,
          canceledAt: row.order.cancellations[0]?.canceledAt ?? null,
          orderUpdatedAt: row.order.updatedAt, issue: row.issue,
        });
        if (currentExpiry && currentExpiry <= new Date()) throw new GoneException('Фото больше не хранится');
        const recent = await db.orderChatImageRevision.count({ where: {
          messageId, createdAt: { gt: new Date(Date.now() - 60000) },
        } });
        if (recent >= 15) throw new HttpException('Слишком много разметок. Подождите минуту.', 429);
        const now = new Date();
        const staff = 'orderId' in actor;
        const retention = row.imageRetention === 'EVIDENCE' || row.issueId ||
          (!staff && row.order.status === 'COMPLETED') ? 'EVIDENCE' : 'OPERATIONAL';
        const version = row.imageRevision + 1;
        const revision = await db.orderChatImageRevision.create({ data: {
          messageId, version, imageKey, requestId: data.requestId,
          actorType: staff ? actor.role : 'CUSTOMER', actorUserId: actor.userId,
          caption: data.text, createdAt: now,
        } });
        const updated = await db.orderChatMessage.update({ where: { id: messageId }, data: {
          imageKey, imageRevision: version, imageRetention: retention,
          imageExpiresAt: imageExpiry({ retention, createdAt: now,
            orderStatus: row.order.status, completedAt: row.order.completedAt,
            canceledAt: row.order.cancellations[0]?.canceledAt ?? null,
            orderUpdatedAt: row.order.updatedAt, issue: row.issue }),
        } });
        await db.order.update({ where: { id }, data: staff
          ? { customerUnread: { increment: 1 } }
          : { staffUnread: { increment: 1 } },
        });
        return { message: publicChatMessage(updated, revision), used: true };
      });
    } catch (error) {
      await this.images.remove(imageKey).catch((cause: unknown) => this.logger.error('Could not remove unwritten chat revision', cause));
      throw error;
    }
    if (!result.used)
      await this.images.remove(imageKey).catch((cause: unknown) => this.logger.error('Could not remove duplicate chat revision', cause));
    return result.message;
  }

  async image(actor: OrderActor, messageId: number, variant: 'full' | 'thumb') {
    const key = await this.locked(actor, async (db, id) => {
      const row = await db.orderChatMessage.findFirst({
        where: { id: messageId, orderId: id },
        select: { imageKey: true, imageDeletedAt: true },
      });
      if (row?.imageDeletedAt) throw new GoneException('Фото больше не хранится');
      if (!row?.imageKey) throw new NotFoundException('Фото не найдено');
      return row.imageKey;
    });
    return this.images.read(key, variant);
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
      let revisionCursor = staff ? order.staffReadImageRevisionId : order.customerReadImageRevisionId;
      const latestMessage = await db.orderChatMessage.findFirst({
        where: { orderId: id }, orderBy: { id: 'desc' }, select: { id: true },
      });
      if (!latestMessage || through >= latestMessage.id) {
        const latestRevision = await db.orderChatImageRevision.findFirst({
          where: { message: { orderId: id }, version: { gt: 0 } },
          orderBy: { id: 'desc' }, select: { id: true },
        });
        revisionCursor = Math.max(revisionCursor, latestRevision?.id ?? 0);
      }
      const unread = await chatUnread(db, id, staff, cursor, revisionCursor);
      await db.order.update({
        where: { id },
        data: staff
          ? { staffReadMessageId: cursor, staffReadImageRevisionId: revisionCursor, staffUnread: unread }
          : { customerReadMessageId: cursor, customerReadImageRevisionId: revisionCursor, customerUnread: unread },
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
