import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Prisma, CustomerTelegramSession } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { CartService } from '../cart/cart.service.js';
import { OrderService } from '../order/order.service.js';
import { orderSchema, addressSchema } from '../order/schema.js';
import { checkoutLimits } from '../order/limits.js';
import {
  checkoutPayload,
  checkoutStep,
  checkoutInput,
  afterType,
  afterText,
  type CheckoutPayload,
} from './checkout.js';
import type { CustomerIdentity } from './customer-send.js';
import type { ShoppingAction } from './shopping-callback.js';
const stale = () =>
  new ConflictException('Ввод уже изменился. Используйте /resume или /cart.');

@Injectable()
export class CustomerCheckoutService {
  constructor(
    private readonly db: DbService,
    private readonly cart: CartService,
    private readonly orders: OrderService,
  ) {}
  private async lock(db: Prisma.TransactionClient, identity: CustomerIdentity) {
    const found = await db.$queryRaw<
      { id: number }[]
    >`SELECT id FROM "TelegramIdentity" WHERE id = ${identity.id} AND "userId" = ${identity.userId} FOR UPDATE`;
    if (!found.length) throw stale();
  }
  private async current(
    db: Prisma.TransactionClient,
    identity: CustomerIdentity,
    revision?: string,
  ) {
    const session = await db.customerTelegramSession.findUnique({
      where: { identityId: identity.id },
    });
    if (
      !session ||
      session.expiresAt <= new Date() ||
      (revision && revision !== session.id)
    )
      throw stale();
    return session;
  }
  start(identity: CustomerIdentity, cartRevision: string) {
    return this.db.$transaction(async (db) => {
      await this.lock(db, identity);
      const cart = await this.cart.getIn(db, identity.userId);
      if (
        cart.revision !== cartRevision ||
        !cart.valid ||
        !cart.items.length ||
        !cart.token
      )
        throw stale();
      const previous = await db.customerTelegramSession.findUnique({
        where: { identityId: identity.id },
      });
      if (
        previous?.action === 'CHECKOUT' &&
        previous.expiresAt > new Date() &&
        checkoutPayload.safeParse(previous.payload).data?.cartRevision ===
          cartRevision
      )
        return previous;
      const user = await db.user.findUniqueOrThrow({
        where: { id: identity.userId },
        select: { name: true, phone: true },
      });
      const last = await db.order.findFirst({
        where: { userId: identity.userId },
        orderBy: { createdAt: 'desc' },
        select: { customerName: true, customerPhone: true },
      });
      const address = await db.address.findFirst({
        where: { userId: identity.userId },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        select: { id: true },
      });
      const name = orderSchema.shape.customerName.safeParse(
        user.name || last?.customerName,
      );
      const data: CheckoutPayload = {
        cartRevision,
        quoteToken: cart.token,
        ...(name.success ? { customerName: name.data } : {}),
        ...(user.phone || last?.customerPhone
          ? { customerPhone: user.phone || last!.customerPhone }
          : {}),
        ...(address ? { addressId: address.id } : {}),
      };
      await db.customerTelegramSession.deleteMany({
        where: { identityId: identity.id },
      });
      return db.customerTelegramSession.create({
        data: {
          identityId: identity.id,
          action: 'CHECKOUT',
          step: 'TYPE',
          payload: checkoutPayload.parse(data),
          expiresAt: new Date(Date.now() + 30 * 60000),
        },
      });
    });
  }
  private async advance(
    db: Prisma.TransactionClient,
    identity: CustomerIdentity,
    session: CustomerTelegramSession,
    step: string,
    data: CheckoutPayload,
  ) {
    if (step === 'CONFIRM') {
      const cart = await this.cart.getIn(db, identity.userId);
      if (cart.revision !== data.cartRevision || !cart.valid || !cart.token)
        throw stale();
      const input = orderSchema.safeParse({ ...data, items: cart.items });
      if (!input.success)
        throw new BadRequestException(
          'Проверьте данные заказа и время получения.',
        );
      checkoutLimits(
        input.data.type,
        cart.subtotal!,
        await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } }),
      );
      data.quoteToken = cart.token;
    }
    return db.customerTelegramSession.update({
      where: { id: session.id },
      data: {
        id: randomUUID(),
        step,
        payload: checkoutPayload.parse(data),
        promptMessageId: null,
      },
    });
  }
  choose(
    identity: CustomerIdentity,
    revision: string,
    choice: Extract<ShoppingAction, { kind: 'flow' }>['choice'],
  ) {
    return this.db.$transaction(async (db) => {
      await this.lock(db, identity);
      const session = await this.current(db, identity, revision);
      if (session.action !== 'CHECKOUT') throw stale();
      const data = checkoutPayload.parse(session.payload);
      if (
        session.step === 'TYPE' &&
        (choice === 'pickup' || choice === 'delivery')
      ) {
        data.type = choice === 'pickup' ? 'PICKUP' : 'DELIVERY';
        return this.advance(db, identity, session, afterType(data), data);
      }
      if (session.step === 'ADDRESS' && choice === 'saved' && data.addressId) {
        const saved = await db.address.findFirst({
          where: { id: data.addressId, userId: identity.userId },
        });
        if (!saved) throw stale();
        data.address = addressSchema.parse(
          Object.fromEntries(
            Object.entries(saved).map(([k, v]) => [
              k,
              v === null ? undefined : v,
            ]),
          ),
        );
        return this.advance(db, identity, session, 'TIME', data);
      }
      if (session.step === 'ADDRESS' && choice === 'new') {
        delete data.address;
        return this.advance(db, identity, session, 'CITY', data);
      }
      if (session.step === 'CONFIRM' && choice === 'edit') {
        delete data.customerName;
        delete data.customerPhone;
        delete data.address;
        delete data.deliveryAt;
        return this.advance(db, identity, session, 'TYPE', data);
      }
      throw stale();
    });
  }
  reply(identity: CustomerIdentity, text: string, promptMessageId: number) {
    return this.db.$transaction(async (db) => {
      await this.lock(db, identity);
      const session = await this.current(db, identity);
      if (
        session.action !== 'CHECKOUT' ||
        !session.promptMessageId ||
        session.promptMessageId !== promptMessageId
      )
        throw stale();
      const step = checkoutStep.parse(session.step);
      let data: CheckoutPayload;
      try {
        data = checkoutInput(
          step,
          text,
          checkoutPayload.parse(session.payload),
        );
      } catch {
        throw new BadRequestException(
          'Проверьте формат ответа. Для пропуска необязательного поля — «-».',
        );
      }
      return this.advance(db, identity, session, afterText(step, data), data);
    });
  }
  cancel(identity: CustomerIdentity, revision: string) {
    return this.db.$transaction(async (db) => {
      await this.lock(db, identity);
      const session = await this.current(db, identity, revision);
      await db.customerTelegramSession.delete({ where: { id: session.id } });
    });
  }
  resume(identity: CustomerIdentity) {
    return this.db.$transaction(async (db) => {
      await this.lock(db, identity);
      const session = await db.customerTelegramSession.findUnique({
        where: { identityId: identity.id },
      });
      if (!session) return null;
      if (session.expiresAt <= new Date()) {
        await db.customerTelegramSession.delete({ where: { id: session.id } });
        return null;
      }
      if (session.action === 'CHECKOUT' && session.step === 'CONFIRM')
        return this.advance(
          db,
          identity,
          session,
          'CONFIRM',
          checkoutPayload.parse(session.payload),
        );
      return db.customerTelegramSession.update({
        where: { id: session.id },
        data: {
          id: randomUUID(),
          promptMessageId: null,
          ...(session.action === 'CHAT' ? { step: 'PROMPT' } : {}),
        },
      });
    });
  }
  async confirm(identity: CustomerIdentity, revision: string) {
    const order = await this.db.$transaction(async (db) => {
      await this.lock(db, identity);
      const session = await this.current(db, identity, revision);
      if (session.action !== 'CHECKOUT' || session.step !== 'CONFIRM')
        throw stale();
      const data = checkoutPayload
        .required({ type: true, customerName: true, customerPhone: true })
        .parse(session.payload);
      // Validate all fields again (including future time); cart supplies authoritative items.
      const input = {
        ...data,
        address: data.address ? addressSchema.parse(data.address) : undefined,
      };
      await db.customerTelegramSession.delete({ where: { id: session.id } });
      return this.cart.checkoutIn(
        db,
        identity.userId,
        data.cartRevision,
        input,
      );
    });
    this.orders.created(order.id);
    return order;
  }
}
