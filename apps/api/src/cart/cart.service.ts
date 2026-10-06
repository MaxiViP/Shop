import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { OrderService, orderCreatedSelect } from '../order/order.service.js';
import { orderSchema, type OrderInput } from '../order/schema.js';
import { cartProductSelect, cartQuantityValid } from '../order/cart-quote.js';
import { manualQuantity } from '../order/assembly.js';
import { customerProduct } from '../product/select.js';

export type CartChange =
  | { kind: 'add' | 'set'; productId: number; qty: number }
  | { kind: 'plus' | 'minus' | 'remove'; productId: number }
  | { kind: 'clear' };

@Injectable()
export class CartService {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderService,
  ) {}

  private async locked(db: Prisma.TransactionClient, userId: number) {
    const user = await db.$queryRaw<
      { id: number }[]
    >`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!user.length) throw new NotFoundException('Аккаунт недоступен');
    const cart = await db.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    await db.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
    return db.cart.findUniqueOrThrow({
      where: { userId },
      include: { items: { orderBy: { productId: 'asc' } } },
    });
  }
  private async snapshot(
    db: Prisma.TransactionClient,
    cart: Awaited<ReturnType<CartService['locked']>>,
  ) {
    const quote = await this.orders.quote({ items: cart.items }, db);
    // Inactive products remain visible to their owner so they can be removed.
    const products = await db.product.findMany({
      where: { id: { in: cart.items.map((item) => item.productId) } },
      select: cartProductSelect,
    });
    return { revision: cart.revision, ...quote, products: products.map(customerProduct) };
  }
  getIn(db: Prisma.TransactionClient, userId: number) {
    return this.locked(db, userId).then((cart) => this.snapshot(db, cart));
  }
  get(userId: number) {
    return this.db.$transaction((db) => this.getIn(db, userId));
  }

  change(userId: number, revision: string, change: CartChange) {
    return this.db.$transaction(async (db) => {
      const cart = await this.locked(db, userId);
      if (cart.revision !== revision)
        throw new ConflictException('Корзина уже изменилась. Откройте /cart.');
      if (change.kind === 'clear')
        await db.cartItem.deleteMany({ where: { cartId: cart.id } });
      else {
        const productId = change.productId;
        if (
          !Number.isSafeInteger(productId) ||
          productId <= 0 ||
          productId > 2147483647
        )
          throw new BadRequestException('Некорректный товар');
        if (change.kind === 'remove')
          await db.cartItem.deleteMany({
            where: { cartId: cart.id, productId },
          });
        else {
          const product = await db.product.findFirst({
            where: { id: productId, active: true },
          });
          if (!product) throw new NotFoundException('Товар больше недоступен');
          const old = cart.items.find((item) => item.productId === productId);
          if (
            (change.kind === 'add' || change.kind === 'set') &&
            !cartQuantityValid(change.qty, product.min, product.step)
          )
            throw new BadRequestException(
              'Количество не соответствует шагу или пределу товара',
            );
          let qty: number | null;
          if (change.kind === 'add') qty = (old?.qty ?? 0) + change.qty;
          else if (change.kind === 'set') qty = change.qty;
          else {
            if (!old) throw new ConflictException('Корзина уже изменилась');
            // Minus clamps at min; the separate remove action is always explicit.
            qty = manualQuantity(
              old.qty,
              product,
              change.kind === 'plus' ? 1 : -1,
            );
          }
          if (
            qty === null ||
            !cartQuantityValid(qty, product.min, product.step)
          )
            throw new BadRequestException(
              'Количество не соответствует шагу или пределу товара',
            );
          if (!old && cart.items.length >= 50)
            throw new BadRequestException('В корзине не больше 50 товаров');
          await db.cartItem.upsert({
            where: { cartId_productId: { cartId: cart.id, productId } },
            create: { cartId: cart.id, productId, qty },
            update: { qty },
          });
        }
      }
      await db.cart.update({
        where: { id: cart.id },
        data: { revision: randomUUID() },
      });
      return this.snapshot(db, await this.locked(db, userId));
    });
  }

  merge(userId: number, revision: string, items: { productId: number; qty: number }[]) {
    return this.db.$transaction(async (db) => {
      const cart = await this.locked(db, userId);
      if (cart.revision !== revision)
        throw new ConflictException('Корзина уже изменилась. Откройте /cart.');
      const existing = new Set(cart.items.map((item) => item.productId));
      const incoming = new Set<number>();
      const additions: { productId: number; qty: number }[] = [];
      for (const item of items) {
        if (incoming.has(item.productId))
          throw new BadRequestException('Повторяющийся товар в корзине');
        incoming.add(item.productId);
        if (!existing.has(item.productId)) additions.push(item);
      }
      if (cart.items.length + additions.length > 50)
        throw new BadRequestException('В корзине не больше 50 товаров');
      if (additions.length) {
        const ids = additions.map((item) => item.productId).sort((a, b) => a - b);
        await db.$queryRaw`SELECT id FROM "Product" WHERE id = ANY(${ids}::int[]) ORDER BY id FOR SHARE`;
        const products = await db.product.findMany({
          where: { id: { in: ids }, active: true },
          select: { id: true, min: true, step: true },
        });
        for (const item of additions) {
          const product = products.find((row) => row.id === item.productId);
          if (!product || !cartQuantityValid(item.qty, product.min, product.step))
            throw new BadRequestException('Проверьте доступность и количество товаров');
        }
        await db.cartItem.createMany({
          data: additions.map((item) => ({ cartId: cart.id, ...item })),
        });
        await db.cart.update({
          where: { id: cart.id },
          data: { revision: randomUUID() },
        });
      }
      return this.snapshot(db, await this.locked(db, userId));
    });
  }

  async checkout(userId: number, revision: string, data: Omit<OrderInput, 'items'>) {
    const result = await this.db.$transaction(async (db) => {
      const saved = await this.checkoutResultIn(db, userId, revision, data);
      const cart = await this.getIn(db, userId);
      return { ...saved, cart };
    });
    if (result.created) this.orders.created(result.order.id);
    return { order: result.order, cart: result.cart };
  }

  // Caller also consumes the checkout session on this SAME transaction connection.
  async checkoutIn(
    db: Prisma.TransactionClient,
    userId: number,
    revision: string,
    data: Omit<OrderInput, 'items'>,
  ) {
    return (await this.checkoutResultIn(db, userId, revision, data)).order;
  }

  private async checkoutResultIn(db: Prisma.TransactionClient, userId: number,
    revision: string, data: Omit<OrderInput, 'items'>) {
    const cart = await this.locked(db, userId);
    if (data.checkoutRequestId) {
      const previous = await db.order.findUnique({ where: { checkoutRequestId: data.checkoutRequestId },
        select: { ...orderCreatedSelect, userId: true } });
      if (previous) {
        if (previous.userId !== userId) throw new ConflictException('Повторное оформление недоступно');
        const { userId: _userId, ...order } = previous;
        return { order, created: false };
      }
    }
    if (cart.revision !== revision)
      throw new ConflictException('Корзина уже изменилась. Откройте /cart.');
    const ids = cart.items.map((item) => item.productId);
    if (!ids.length) throw new BadRequestException('Корзина пуста');
    // Product edits/deletion cannot slip between final quote and snapshot creation.
    await db.$queryRaw`SELECT id FROM "Product" WHERE id = ANY(${ids}::int[]) ORDER BY id FOR SHARE`;
    const input = orderSchema.safeParse({ ...data, items: cart.items });
    if (!input.success)
      throw new BadRequestException(
        'Проверьте данные заказа и время получения.',
      );
    const result = await this.orders.createIn(db, userId, input.data);
    await db.cartItem.deleteMany({ where: { cartId: cart.id } });
    await db.cart.update({
      where: { id: cart.id },
      data: { revision: randomUUID() },
    });
    return { order: result.order, created: result.created };
  }
}
