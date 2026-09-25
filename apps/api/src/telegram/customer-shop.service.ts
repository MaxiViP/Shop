import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CustomerTelegramSession } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { CartService } from '../cart/cart.service.js';
import { OrderService } from '../order/order.service.js';
import { cartProductSelect, cartQuantityValid } from '../order/cart-quote.js';
import { goodsLine } from '../order/pricing.js';
import { manualQuantity } from '../order/assembly.js';
import { CustomerCheckoutService } from './customer-checkout.service.js';
import { checkoutScreen, paymentScreen } from './shopping-view.js';
import {
  customerShow,
  customerPrompt,
  type CustomerTarget,
  type CustomerIdentity,
} from './customer-send.js';
import { shoppingData, type ShoppingAction } from './shopping-callback.js';
import { customerView } from './customer-callback.js';
import {
  amount,
  quantity,
  short,
  type Button,
} from './customer-view.js';

const navigation: Button[][] = [
  [
    { text: '🛒 Корзина', callback_data: 'cart' },
    { text: 'Меню', callback_data: 'menu' },
  ],
];

@Injectable()
export class CustomerShopService {
  constructor(
    private readonly db: DbService,
    private readonly cart: CartService,
    private readonly checkout: CustomerCheckoutService,
    private readonly orders: OrderService,
  ) {}

  private async categories(target: CustomerTarget, page = 0) {
    const rows = await this.db.category.findMany({
      where: { active: true },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      skip: page * 8,
      take: 9,
      select: { id: true, name: true },
    });
    const buttons: Button[][] = rows.slice(0, 8).map((row) => [
      {
        text: short(row.name, 50),
        callback_data: shoppingData('l', row.id, 0),
      },
    ]);
    const nav: Button[] = [];
    if (page)
      nav.push({ text: '←', callback_data: shoppingData('c', page - 1) });
    if (rows.length > 8 && page < 10000)
      nav.push({ text: '→', callback_data: shoppingData('c', page + 1) });
    return customerShow(target, {
      text: '🛍 Каталог\nВыберите категорию.',
      keyboard: {
        inline_keyboard: [
          ...buttons,
          ...(nav.length ? [nav] : []),
          ...navigation,
        ],
      },
    });
  }
  private async products(
    target: CustomerTarget,
    categoryId: number,
    page: number,
  ) {
    const category = await this.db.category.findFirst({
      where: { id: categoryId, active: true },
      select: { name: true },
    });
    if (!category) throw new NotFoundException('Категория недоступна');
    const rows = await this.db.product.findMany({
      where: { active: true, categoryId },
      select: cartProductSelect,
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      skip: page * 6,
      take: 7,
    });
    const buttons: Button[][] = rows.slice(0, 6).map((p) => [
      {
        text: short(p.name, 45) + ' · ' + amount(p.price),
        callback_data: shoppingData('v', p.id, p.min),
      },
    ]);
    const nav: Button[] = [];
    if (page)
      nav.push({
        text: '←',
        callback_data: shoppingData('l', categoryId, page - 1),
      });
    if (rows.length > 6 && page < 10000)
      nav.push({
        text: '→',
        callback_data: shoppingData('l', categoryId, page + 1),
      });
    return customerShow(target, {
      text:
        short(category.name, 100) +
        '\n\n' +
        (rows
          .slice(0, 6)
          .map(
            (p) =>
              short(p.name, 80) +
              ' — ' +
              amount(p.price) +
              ' / ' +
              quantity(p.priceQty, p.unit),
          )
          .join('\n') || 'Товаров пока нет.'),
      keyboard: {
        inline_keyboard: [
          ...buttons,
          ...(nav.length ? [nav] : []),
          [{ text: '← Категории', callback_data: 'catalog' }],
          ...navigation,
        ],
      },
    });
  }
  private async product(
    target: CustomerTarget,
    identity: CustomerIdentity,
    productId: number,
    qty: number,
  ) {
    const p = await this.db.product.findFirst({
      where: { id: productId, active: true, category: { active: true } },
      select: { ...cartProductSelect, categoryId: true },
    });
    if (!p) throw new NotFoundException('Товар больше недоступен');
    if (!cartQuantityValid(qty, p.min, p.step))
      throw new BadRequestException('Проверьте количество товара');
    const basket = await this.cart.get(identity.userId);
    const down = manualQuantity(qty, p, -1),
      up = manualQuantity(qty, p, 1);
    const controls: Button[] = [];
    if (down !== null)
      controls.push({
        text: '−',
        callback_data: shoppingData('v', p.id, down),
      });
    controls.push({
      text: quantity(qty, p.unit),
      callback_data: shoppingData('v', p.id, qty),
    });
    if (up !== null)
      controls.push({ text: '+', callback_data: shoppingData('v', p.id, up) });
    return customerShow(target, {
      text:
        short(p.name, 180) +
        '\nЦена: ' +
        amount(p.price) +
        ' / ' +
        quantity(p.priceQty, p.unit) +
        '\nОт ' +
        quantity(p.min, p.unit) +
        ' · шаг ' +
        quantity(p.step, p.unit) +
        '\nВыбрано: ' +
        quantity(qty, p.unit) +
        '\nПредварительно: ≈ ' +
        amount(goodsLine(p.price, qty, p.priceQty)),
      keyboard: {
        inline_keyboard: [
          controls,
          [
            {
              text: '➕ В корзину',
              callback_data: shoppingData('a', basket.revision, p.id, qty),
            },
          ],
          [
            {
              text: '← К товарам',
              callback_data: shoppingData('l', p.categoryId, 0),
            },
          ],
          ...navigation,
        ],
      },
    });
  }
  async basket(target: CustomerTarget, identity: CustomerIdentity, page = 0) {
    const basket = await this.cart.get(identity.userId);
    page = Math.min(page, Math.max(0, Math.ceil(basket.items.length / 5) - 1));
    const visible = basket.items.slice(page * 5, page * 5 + 5);
    const lines = visible.map((item) =>
      item.product
        ? short(item.product.name, 120) +
          '\n' +
          quantity(item.qty, item.product.unit) +
          ' · ≈ ' +
          amount(item.lineTotal) +
          (item.status === 'AVAILABLE'
            ? ''
            : '\n⚠️ Проверьте количество / стоимость')
        : 'Товар больше недоступен',
    );
    const buttons: Button[][] = visible.flatMap((item) => [
      [
        {
          text: short(item.product?.name ?? 'Недоступный товар', 40),
          callback_data: item.product
            ? shoppingData('v', item.productId, item.product.min)
            : 'cart',
        },
      ],
      [
        ...(item.product
          ? [
              {
                text: '−',
                callback_data: shoppingData(
                  '-',
                  basket.revision,
                  item.productId,
                ),
              },
              {
                text: '+',
                callback_data: shoppingData(
                  '+',
                  basket.revision,
                  item.productId,
                ),
              },
            ]
          : []),
        {
          text: 'Удалить',
          callback_data: shoppingData('x', basket.revision, item.productId),
        },
      ],
    ]);
    const nav: Button[] = [];
    if (page)
      nav.push({ text: '←', callback_data: shoppingData('k', page - 1) });
    if ((page + 1) * 5 < basket.items.length)
      nav.push({ text: '→', callback_data: shoppingData('k', page + 1) });
    if (nav.length) buttons.push(nav);
    if (basket.items.length) {
      if (basket.valid)
        buttons.push([
          {
            text: '✅ Оформить заказ',
            callback_data: shoppingData('b', basket.revision),
          },
        ]);
      buttons.push([
        {
          text: 'Очистить корзину',
          callback_data: shoppingData('z', basket.revision),
        },
      ]);
    }
    buttons.push([
      { text: 'Продолжить покупки', callback_data: 'catalog' },
      { text: 'Меню', callback_data: 'menu' },
    ]);
    return customerShow(target, {
      text:
        '🛒 Корзина\n\n' +
        (lines.join('\n\n') || 'Корзина пуста.') +
        (basket.items.length
          ? '\n\nПредварительно: ≈ ' +
            amount(basket.subtotal) +
            '\nТочная сумма весовых товаров — после сборки.'
          : ''),
      keyboard: { inline_keyboard: buttons },
    });
  }
  async present(
    target: CustomerTarget,
    identity: CustomerIdentity,
    session: CustomerTelegramSession,
  ) {
    const screen = checkoutScreen(
      session,
      session.step === 'CONFIRM' ? await this.cart.get(identity.userId) : null,
    );
    if (!('prompt' in screen)) return customerShow(target, screen);
    const promptMessageId = await customerPrompt(target.chatId, screen.prompt);
    if (promptMessageId)
      await this.db.customerTelegramSession.updateMany({
        where: {
          id: session.id,
          identityId: identity.id,
          identity: { userId: identity.userId },
          action: 'CHECKOUT',
          step: session.step,
          promptMessageId: null,
          expiresAt: { gt: new Date() },
        },
        data: { promptMessageId },
      });
    // UNKNOWN retains the current durable, unbound step; presentation is never retried automatically.
  }
  async payment(
    target: CustomerTarget,
    identity: CustomerIdentity,
    publicId: string,
    method: 'SBP' | 'CARD_TRANSFER' | 'QR',
  ) {
    return customerShow(
      target,
      paymentScreen(await this.orders.get(publicId, identity.userId), method),
    );
  }
  async handle(
    target: CustomerTarget,
    identity: CustomerIdentity,
    action: ShoppingAction,
  ) {
    switch (action.kind) {
      case 'catalog':
        return this.categories(target);
      case 'categories':
        return this.categories(target, action.page);
      case 'products':
        return this.products(target, action.categoryId, action.page);
      case 'product':
        return this.product(target, identity, action.productId, action.qty);
      case 'cart':
        return this.basket(target, identity);
      case 'basket':
        return this.basket(target, identity, action.page);
      case 'add':
      case 'plus':
      case 'minus':
      case 'remove':
      case 'clear':
        await this.cart.change(
          identity.userId,
          action.revision,
          action.kind === 'clear' ? { kind: 'clear' } : action,
        );
        return this.basket(target, identity);
      case 'checkout':
        return this.present(
          target,
          identity,
          await this.checkout.start(identity, action.revision),
        );
      case 'flow':
        if (action.choice === 'cancel') {
          await this.checkout.cancel(identity, action.revision);
          return customerShow(target, {
            text: 'Ввод отменён. Товары остались в корзине.',
            keyboard: { inline_keyboard: navigation },
          });
        }
        if (action.choice === 'confirm') {
          const order = await this.checkout.confirm(identity, action.revision);
          return customerShow(target, {
            text:
              '✅ Заказ создан\nЗаказ №' +
              order.id +
              '\nПредварительная сумма товаров: ≈ ' +
              amount(order.subtotal),
            keyboard: {
              inline_keyboard: [
                [
                  {
                    text: 'Посмотреть заказ',
                    callback_data: customerView('o', order.publicId),
                  },
                ],
                [
                  {
                    text: 'Написать продавцу',
                    callback_data: customerView('w', order.publicId),
                  },
                ],
                [{ text: 'В магазин', callback_data: 'catalog' }],
              ],
            },
          });
        }
        return this.present(
          target,
          identity,
          await this.checkout.choose(identity, action.revision, action.choice),
        );
      case 'pay':
        return this.payment(target, identity, action.publicId, action.method);
      case 'paid':
        await this.orders.reportPayment(
          action.publicId,
          identity.userId,
          undefined,
          action.method,
        );
        return this.payment(target, identity, action.publicId, action.method);
      case 'help':
        return customerShow(target, {
          text: 'Покупки в KorzinaMarket\n/catalog — каталог\n/cart — корзина и оформление\n/orders — заказы\n/current — текущий заказ\n/messages — вопросы и сообщения\n/resume — продолжить ввод\n/cancel — отменить ввод\n\nВес и итог уточняются после сборки. После перевода нажмите «Я оплатил» — продавец проверит деньги. По заказу можно написать продавцу.',
          keyboard: { inline_keyboard: navigation },
        });
      case 'resume':
        return;
    }
  }
}
