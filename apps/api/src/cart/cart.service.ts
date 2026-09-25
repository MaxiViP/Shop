import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { OrderService } from '../order/order.service.js';
import { orderSchema, type OrderInput } from '../order/schema.js';
import { cartQuantityValid } from '../order/cart-quote.js';
import { manualQuantity } from '../order/assembly.js';

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
    return { revision: cart.revision, ...quote };
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

  // Caller also consumes the checkout session on this SAME transaction connection.
  async checkoutIn(
    db: Prisma.TransactionClient,
    userId: number,
    revision: string,
    data: Omit<OrderInput, 'items'>,
  ) {
    const cart = await this.locked(db, userId);
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
    return result.order;
  }
}
