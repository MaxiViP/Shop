import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CustomerTelegramSession } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { CartService } from '../cart/cart.service.js';
import { QuickShopService } from '../cart/quick-shop.service.js';
import { OrderService } from '../order/order.service.js';
import { cartProductSelect, cartQuantityValid } from '../order/cart-quote.js';
import { customerProduct } from '../product/select.js';
import { requestedLine } from '../order/pricing.js';
import { orderableProductWhere } from '../product/select.js';
import { pageInfo } from './page.js';
import { bold, heading, paragraph, richTable, productPhoto, type InputRichBlock, type RichText } from './rich.js';
import { priceUnit, saleModel, variableWeight } from '../product/sale.js';
import { CustomerCheckoutService } from './customer-checkout.service.js';
import { checkoutScreen, paymentScreen, clearCartScreen, shoppingHelpScreen } from './shopping-view.js';
import { receivingPayload, receivingScreen, isReceiving } from './receiving.js';
import {
  customerShow,
  customerPrompt,
  type CustomerTarget,
  type CustomerIdentity,
} from './customer-send.js';
import { shoppingData, productData, adjustData, type ShopContext, type ShoppingAction } from './shopping-callback.js';
import { catalogPair } from './catalog-photo.js';
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
type Basket = Awaited<ReturnType<CartService['get']>>;
const estimate = (value: number | null) => value === null ? 'после взвешивания' : '≈ ' + amount(value);
function productCount(count: number) {
  const last = count % 10, hundred = count % 100;
  return count + ' ' + (last === 1 && hundred !== 11 ? 'товар' :
    last >= 2 && last <= 4 && (hundred < 12 || hundred > 14) ? 'товара' : 'товаров');
}
function cartFeedback(before: Basket, after: Basket, productId: number): string {
  const old = before.items.find(item => item.productId === productId);
  const saved = after.items.find(item => item.productId === productId);
  if (old && !saved) return '🗑 Удалён: ' + short(old.product?.name ?? 'Товар', 180);
  const updated = '✅ Количество обновлено\nСтоимость пересчитана';
  const priced = saved?.product;
  if (!saved || !priced || saved.status !== 'AVAILABLE' || (old && (old.status !== 'AVAILABLE' || !old.product ||
    (old.quantityUnit ?? old.product.unit) !== (saved.quantityUnit ?? priced.unit) ||
    old.product.unit !== priced.unit || old.product.price !== priced.price || old.product.priceQty !== priced.priceQty ||
    old.product.priceStatus !== priced.priceStatus || priceUnit(old.product) !== priceUnit(priced) ||
    saleModel(old.product) !== saleModel(priced) || old.product.estimatedWeightGrams !== priced.estimatedWeightGrams))) return updated;
  const deltaQty = saved.qty - (old?.qty ?? 0);
  // Both totals come from acknowledged CartService quotes. Never price a requested step here.
  if (!deltaQty || saved.lineTotal === null || (old && old.lineTotal === null)) return updated;
  const deltaAmount = saved.lineTotal - (old?.lineTotal ?? 0);
  if ((deltaQty > 0 && deltaAmount < 0) || (deltaQty < 0 && deltaAmount > 0)) return updated;
  const sign = deltaQty > 0 ? '+' : '−';
  const approximate = priced.unit === 'GRAM' || variableWeight(priced) || priced.priceStatus !== 'SOURCE';
  const delta = sign + quantity(Math.abs(deltaQty), saved.quantityUnit ?? priced.unit) + ' · ' +
    sign + (approximate ? '≈ ' : '') + amount(Math.abs(deltaAmount));
  return old ? (deltaQty > 0 ? '✅ ' : '➖ ') + delta :
    '✅ Добавлен: ' + short(priced.name, 180) + '\n' + delta;
}

@Injectable()
export class CustomerShopService {
  constructor(
    private readonly db: DbService,
    private readonly cart: CartService,
    private readonly checkout: CustomerCheckoutService,
    private readonly orders: OrderService,
    private readonly quick: QuickShopService,
  ) {}

  async cartLabel(identity: CustomerIdentity): Promise<string> {
    const basket = await this.cart.get(identity.userId);
    return basket.items.length
      ? '🛒 Корзина · ' + basket.items.length + ' поз. · ' + estimate(basket.goodsTotal)
      : '🛒 Корзина пуста';
  }
  private async quickShop(target: CustomerTarget, identity: CustomerIdentity, requested: number) {
    const result = await this.quick.get(identity.userId);
    const info = pageInfo(result.items.length, requested, 8);
    const rows = result.items.slice(info.skip, info.skip + 8);
    const names = rows.map(row => short(row.product.name, 70));
    return customerShow(target, {
      text: '⚡ Быстрые покупки\n\n' + (rows.length ? 'Привычные товары по текущим ценам.' + (info.pages > 1 ? '\n' + info.label : '') : 'Выберите продукты в каталоге.'),
      keyboard: { inline_keyboard: [
        ...rows.map(row => [{ text: (names.filter(name => name === short(row.product.name, 70)).length > 1
          ? short(row.product.name, 60) + ' · №' + row.product.id : short(row.product.name, 70)) +
          ' · ' + amount(row.product.price) + ' / ' + quantity(row.product.priceQty, priceUnit(row.product)),
          callback_data: productData(row.product.id, { page: info.page, origin: 'quick' }) }]),
        ...(info.pages > 1 ? [[
          ...(info.page ? [{ text: '← Предыдущие', callback_data: shoppingData('q', info.page - 1) }] : []),
          ...(info.page + 1 < info.pages ? [{ text: 'Следующие →', callback_data: shoppingData('q', info.page + 1) }] : []),
        ]] : []),
        ...(result.lastOrder ? [[{ text: 'Повторить заказ №' + result.lastOrder.id,
          callback_data: shoppingData('e', result.cart.revision, result.lastOrder.id), style: 'primary' as const }]] : []),
        ...navigation,
      ] },
    });
  }

  private async categories(target: CustomerTarget, requested = 0) {
    const where = { active: true, products: { some: { active: true } } };
    const { rows, info } = await this.db.$transaction(async db => {
      const total = await db.category.count({ where });
      const size = total <= 48 ? 48 : 24;
      const info = pageInfo(total, requested, size);
      const rows = await db.category.findMany({ where, orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        skip: info.skip, take: size, select: { id: true, name: true } });
      return { rows, info };
    }, { isolationLevel: 'RepeatableRead' });
    const buttons: Button[][] = [];
    for (let index = 0; index < rows.length; index += 2) buttons.push(rows.slice(index, index + 2).map(row => ({
      text: short(row.name, 34), callback_data: shoppingData('l', row.id, 0),
    })));
    const nav: Button[] = [];
    if (info.page) nav.push({ text: '← Предыдущие категории', callback_data: shoppingData('c', info.page - 1) });
    if (info.page + 1 < info.pages) nav.push({ text: 'Следующие категории →', callback_data: shoppingData('c', info.page + 1) });
    return customerShow(target, {
      text: 'Каталог KorzinaMarket\n\nСвежие продукты с московского рынка.\n' +
        (rows.length ? 'Выберите категорию.' + (info.pages > 1 ? '\n\n' + info.label : '') : 'Доступных товаров пока нет.'),
      keyboard: { inline_keyboard: [...buttons, ...(nav.length ? [nav] : []), ...navigation] },
    });
  }
  private async products(target: CustomerTarget, identity: CustomerIdentity, categoryId: number, requested: number,
    options: { basket?: Basket; feedback?: string; browsingOnly?: boolean } = {}) {
    const category = await this.db.category.findFirst({ where: { id: categoryId, active: true }, select: { name: true } });
    if (!category) throw new NotFoundException('Категория недоступна');
    const where = { ...orderableProductWhere, categoryId };
    const { rows, info, total, categoryPage } = await this.db.$transaction(async db => {
      const total = await db.product.count({ where }), info = pageInfo(total, requested, 8);
      const rows = (await db.product.findMany({ where, select: cartProductSelect,
        orderBy: [{ sort: 'asc' }, { id: 'asc' }], skip: info.skip, take: 8 })).map(customerProduct);
      const categories = await db.category.findMany({ where: { active: true, products: { some: { active: true } } },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }], select: { id: true } });
      const categoryPage = categories.length <= 48 ? 0 : Math.floor(Math.max(0, categories.findIndex(row => row.id === categoryId)) / 24);
      return { rows, info, total, categoryPage };
    }, { isolationLevel: 'RepeatableRead' });
    const basket = options.browsingOnly ? null : options.basket ?? await this.cart.get(identity.userId);
    const context: ShopContext = { page: info.page, origin: 'category', categoryId };
    const cards = rows.map(source => {
      const item = basket?.items.find(item => item.productId === source.id), p = { ...source, ...item?.product };
      const price = (p.priceStatus !== 'SOURCE' ? '≈' : '') + amount(p.price) + '/' +
        (priceUnit(p) === 'GRAM' && p.priceQty === 1000 ? 'кг' : p.priceQty === 1 ? quantity(1, priceUnit(p)).replace(/^1 /, '') : quantity(p.priceQty, priceUnit(p)));
      const open: Button = { text: 'Открыть товар', style: 'primary', callback_data: productData(p.id, context) };
      const controls: Button[] = [];
      let add: Button;
      if (!basket) add = { text: 'Добавить в ', callback_data: 'verify_phone', style: 'success' };
      else if (item && item.status !== 'AVAILABLE') {
        add = { text: 'Добавить в ', disabled: {}, style: 'success' };
        controls.push({ text: '⚠️ Проверить корзину', callback_data: 'cart' });
      } else {
        const current = item?.qty ?? 0, delta = current ? p.step : p.min;
        if (current) controls.push({ text: '−', ...(current === p.step || cartQuantityValid(current - p.step, p.min, p.step)
          ? { callback_data: adjustData(basket!.revision, p.id, -p.step, p.unit, context, true) } : { disabled: {} }) });
        const canAdd = cartQuantityValid(current + delta, p.min, p.step) && (!variableWeight(p) || current + delta <= 100);
        add = { text: 'Добавить в ', style: 'success', ...(canAdd
          ? { callback_data: adjustData(basket.revision, p.id, delta, p.unit, context, true) } : { disabled: {} }) };
        if (current) controls.push({ ...add, text: '+' });
      }
      return { p, item, price, open, add, controls };
    });
    const gallery: InputRichBlock[] = [], mediaFallback: InputRichBlock[] = [];
    const htmlRows: Button[][] = [];
    for (let index = 0; index < cards.length; index += 2) {
      const pair = cards.slice(index, index + 2);
      const media = await catalogPair(pair.map(({ p, price }) => ({ id: p.id, name: p.name, price: p.price,
        priceQty: p.priceQty, priceUnit: priceUnit(p), priceStatus: p.priceStatus, priceText: price,
        photo: p.images.map(image => productPhoto(image.url)?.photo.media).find(Boolean) })));
      const actions: InputRichBlock[] = [
        { type: 'buttons', align: pair.length === 2 ? 'center' : 'left', buttons: pair.map(card => card.open) },
        { type: 'buttons', align: pair.length === 2 ? 'center' : 'left', buttons: pair.map(card => card.add) },
      ];
      for (const card of pair) {
        if (card.item) actions.push(paragraph([short(card.p.name, 100), ' · В корзине: ', bold(quantity(card.item.qty, card.item.quantityUnit ?? card.p.unit))]));
        if (card.controls.length) actions.push({ type: 'buttons', buttons: card.controls, align: 'left' });
        htmlRows.push([{ ...card.open, text: short(card.p.name, 85) + ' · ' + card.price }, card.add]);
        if (card.controls.length) htmlRows.push(card.controls);
      }
      gallery.push({ type: 'photo', photo: { type: 'photo', media } }, ...actions);
      for (const card of pair) mediaFallback.push(paragraph([short(card.p.name, 300), '\n', bold(card.price)]),
        { type: 'buttons', buttons: [card.open, card.add], align: 'left' },
        ...(card.item ? [paragraph(['В корзине: ', bold(quantity(card.item.qty, card.item.quantityUnit ?? card.p.unit))])] : []),
        ...(card.controls.length ? [{ type: 'buttons' as const, buttons: card.controls, align: 'left' as const }] : []));
    }
    const nav: Button[][] = [];
    const pages: Button[] = [];
    if (info.page) pages.push({ text: '← Предыдущие товары', callback_data: shoppingData('l', categoryId, info.page - 1) });
    if (info.page + 1 < info.pages) pages.push({ text: 'Следующие товары →', callback_data: shoppingData('l', categoryId, info.page + 1) });
    if (pages.length) nav.push(pages);
    nav.push([{ text: '← Категории', callback_data: shoppingData('c', categoryPage) }], ...navigation);
    const range = `${info.first}–${info.last}/${total}`, pageLabel = info.pages > 1 ? ` · ${info.page + 1}/${info.pages}` : '';
    const header = short(category.name, Math.max(8, 42 - range.length - pageLabel.length - 3)) + ' · ' + range + pageLabel;
    const top: InputRichBlock[] = [paragraph(header), ...(options.feedback ? [paragraph(options.feedback)] : []), ...(!cards.length ? [paragraph('Товаров пока нет.')] : [])];
    const descriptions = cards.map((card, index) => `${index + 1}. ${short(card.p.name, 300)}\n${card.price}` +
      (card.item ? '\nВ корзине: ' + quantity(card.item.qty, card.item.quantityUnit ?? card.p.unit) : '')).join('\n\n');
    return customerShow(target, {
      text: header + (options.feedback ? '\n\n' + options.feedback : '') + '\n\n' + (descriptions || 'Товаров пока нет.'),
      rich: { blocks: [...top, ...gallery] }, mediaFallback: [...top, ...mediaFallback],
      richKeyboard: { inline_keyboard: nav }, keyboard: { inline_keyboard: [...htmlRows, ...nav] },
    });
  }

  private async product(target: CustomerTarget, identity: CustomerIdentity, productId: number,
    options: { basket?: Basket; browsingOnly?: boolean; context?: ShopContext; details?: boolean; feedback?: string } = {}) {
    const source = await this.db.product.findFirst({
      where: { ...orderableProductWhere, id: productId },
      select: { ...cartProductSelect, categoryId: true, description: true },
    });
    if (!source) throw new NotFoundException('Товар больше недоступен');
    const basket = options.browsingOnly ? null : options.basket ?? await this.cart.get(identity.userId);
    const inCart = basket?.items.find(item => item.productId === productId);
    const p = { ...customerProduct(source), ...inCart?.product }, context = options.context ?? { page: 0, origin: 'category' as const };
    const photo = p.images.map(image => productPhoto(image.url)).find(value => value !== undefined);
    const back = { text: context.origin === 'basket' ? '← К корзине' : context.origin === 'quick' ? '← К моим продуктам' : '← К товарам',
      callback_data: context.origin === 'basket' ? shoppingData('k', context.page) : context.origin === 'quick' ? shoppingData('q', context.page) : shoppingData('l', context.categoryId ?? p.categoryId, context.page) };
    const rules = 'От ' + quantity(p.min, p.unit) + ' · шаг ' + quantity(p.step, p.unit);
    const price = amount(p.price) + ' / ' + quantity(p.priceQty, priceUnit(p));
    const hint = (qty: number) => {
      const value = requestedLine({ ...p, qty });
      return value === null ? 'После взвешивания' : (p.unit === 'GRAM' || variableWeight(p) || p.priceStatus !== 'SOURCE' ? '≈ ' : '') + amount(value);
    };
    if (!basket) return customerShow(target, {
      rich: { blocks: [heading(short(p.name, 180)), ...(photo ? [photo] : []), paragraph(price + '\n' + rules), paragraph('Для покупок подтвердите свой номер Telegram.')] },
      ...(!photo ? { mediaReason: p.images.length ? 'invalid_url' as const : 'no_image' as const } : {}),
      text: short(p.name, 180) + '\nЦена: ' + price + '\n' + rules +
        '\n\nДля покупок подтвердите свой номер Telegram.',
      keyboard: { inline_keyboard: [[{ text: '📱 Подтвердить номер', callback_data: 'verify_phone', style: 'primary' }], [back, { text: 'Меню', callback_data: 'menu' }]] },
    });
    const current = inCart?.qty ?? 0;
    const canAdd = !inCart || inCart.status === 'AVAILABLE';
    const controls: Button[][] = [];
    const mutation = (delta: number, label?: string): Button => ({
      text: label ?? (delta < 0 ? '➖ Уменьшить' : '➕ Увеличить'),
      callback_data: adjustData(basket.revision, p.id, delta, p.unit, context),
      ...(delta > 0 ? { style: 'success' as const } : {}),
    });
    if (canAdd) {
      const row: Button[] = [];
      if (current === p.step || (current > p.step && cartQuantityValid(current - p.step, p.min, p.step))) row.push(mutation(-p.step));
      {
        const delta = current ? p.step : p.min, next = current + delta;
        try { if (cartQuantityValid(next, p.min, p.step) && (!variableWeight(p) || next <= 100)) row.push(mutation(delta,
          current ? undefined : '🛒 Добавить в корзину · ' + quantity(delta, p.unit) + ' · ' + hint(delta))); }
        catch (error) { if (!(error instanceof BadRequestException)) throw error; }
      }
      if (row.length) controls.push(row);
    }
    const selection = quantity(current, inCart?.quantityUnit ?? p.unit) + (inCart ? ' · ' + estimate(inCart.lineTotal) : '');
    const detailBlocks: InputRichBlock[] = options.details && p.description ? [{ type: 'details', summary: 'Описание', blocks: [paragraph(short(p.description, 1000))] }] : [];
    const text = (options.feedback ? options.feedback + '\n\n' : '') + short(p.name, 180) + '\nЦена: ' + price + '\n' + rules +
      (variableWeight(p) ? '\nЦеликом, в ' + (p.unit === 'BUNCH' ? 'пучках' : 'штуках') + '. Каждый экземпляр взвесим отдельно.' : '') +
      (p.estimatedWeightGrams ? '\nОжидаемый вес экземпляра: ' + quantity(p.estimatedWeightGrams, 'GRAM') + ' · ' + hint(1) : '') +
      '\n\nВ корзине этого товара: ' + selection + '\nВся корзина: ' + basket.items.length + ' поз. · ' + estimate(basket.goodsTotal) +
      (!canAdd ? '\n⚠️ Условия товара изменились. Удалите прежнюю позицию в корзине и выберите количество заново.' : '') +
      (options.details && p.description ? '\n\n' + short(p.description, 1000) : '');
    return customerShow(target, {
      text,
      fallback: text.split('\n').map((line, index) => line.startsWith('В корзине этого товара: ')
        ? ['В корзине: ', bold(selection)] : index === 0 ? bold(line) : line),
      ...(!photo ? { mediaReason: p.images.length ? 'invalid_url' as const : 'no_image' as const } : {}),
      rich: { blocks: [heading(short(p.name, 180)), ...(options.feedback ? [paragraph(bold(options.feedback))] : []),
        ...(photo ? [photo] : []), paragraph(price + '\n' + rules),
        richTable([['В корзине', selection], ['Вся корзина', basket.items.length + ' поз. · ' + estimate(basket.goodsTotal)]]),
        ...(!canAdd ? [paragraph('⚠️ Условия товара изменились. Удалите прежнюю позицию в корзине и выберите количество заново.')] : []),
        ...(variableWeight(p) ? [paragraph('Целые экземпляры. Точная стоимость после взвешивания.')] : []),
        ...(p.estimatedWeightGrams ? [paragraph('Ожидаемый вес экземпляра: ' + quantity(p.estimatedWeightGrams, 'GRAM') + ' · ' + hint(1))] : []),
        ...detailBlocks] },
      keyboard: { inline_keyboard: [...controls,
        [{ text: options.details ? 'Краткая карточка' : '📷 Фото и описание', callback_data: productData(p.id, context, !options.details) }],
        [back, { text: '🛒 Корзина', callback_data: 'cart' }]] },
    });
  }
  private async adjust(target: CustomerTarget, identity: CustomerIdentity, action: Extract<ShoppingAction, { kind: 'adjust' }>) {
    const before = await this.cart.get(identity.userId);
    const context: ShopContext = { page: action.page, origin: action.origin, ...(action.categoryId === undefined ? {} : { categoryId: action.categoryId }) };
    const show = (basket: Basket, feedback: string) => action.inCategory && action.categoryId !== undefined
      ? this.products(target, identity, action.categoryId, action.page, { basket, feedback })
      : this.product(target, identity, action.productId, { basket, context, feedback });
    if (before.revision !== action.revision) {
      await show(before, 'Корзина уже изменилась. Ниже — актуальное количество. Старое действие не применено.');
      throw new ConflictException('Корзина уже изменилась');
    }
    const old = before.items.find(item => item.productId === action.productId), current = old?.qty ?? 0;
    const next = current + action.delta;
    if (next < 0 || (!current && action.delta < 0) || (old && (old.status !== 'AVAILABLE' ||
      (old.quantityUnit ?? old.product?.unit) !== action.quantityUnit))) throw new BadRequestException('Проверьте количество товара');
    let basket: Basket;
    try {
      basket = await this.cart.change(identity.userId, action.revision, next === 0
        ? { kind: 'remove', productId: action.productId }
        : { kind: 'set', productId: action.productId, qty: next, quantityUnit: action.quantityUnit });
    } catch (error) {
      // No mutation replay, even for a lost response after commit. A read also waits for the cart lock.
      try {
        const latest = await this.cart.get(identity.userId);
        await show(latest, 'Изменение не подтверждено. Корзина перечитана — проверьте количество перед следующим действием.');
      } catch { /* Keep the old card; its revision remains fenced by CartService. */ }
      throw error;
    }
    const feedback = cartFeedback(before, basket, action.productId);
    if (context.origin === 'basket') return this.basket(target, identity, context.page, basket, feedback);
    return show(basket, feedback);
  }
  async basket(target: CustomerTarget, identity: CustomerIdentity, page = 0, saved?: Basket, feedback?: string) {
    const basket = saved ?? await this.cart.get(identity.userId);
    page = Math.min(page, Math.max(0, Math.ceil(basket.items.length / 5) - 1));
    const visible = basket.items.slice(page * 5, page * 5 + 5);
    const itemInfo = visible.map((item) => {
      const p = item.product;
      const unit = item.quantityUnit ?? p?.unit;
      const approximate = !p || p.unit === 'GRAM' || variableWeight(p) || p.priceStatus !== 'SOURCE';
      return { qty: unit ? quantity(item.qty, unit) : 'Количество уточняется',
        total: item.lineTotal == null ? 'Стоимость после взвешивания' : (approximate ? '≈' : '') + amount(item.lineTotal),
        step: p && p.min > p.step ? 'Минимум: ' + quantity(p.min, p.unit) + ' · шаг ' + quantity(p.step, p.unit) : '',
        warning: item.status === 'AVAILABLE' ? '' : '⚠️ Проверьте количество / стоимость' };
    });
    const itemLines = itemInfo.map((info): RichText[] => [[bold(info.qty), ' · ', bold(info.total)],
      ...[info.step, info.warning].filter(Boolean)]);
    const lines = visible.map((item, index) => {
      const info = itemInfo[index]!;
      return [short(item.product?.name ?? 'Товар больше недоступен', 300), info.qty + ' · ' + info.total,
        info.step, info.warning].filter(Boolean).join('\n');
    });
    const buttons: Button[][] = visible.map(item => {
      const p = item.product, available = p && item.status === 'AVAILABLE';
      const context = { page, origin: 'basket' as const };
      const minus = available && (item.qty === p.step || cartQuantityValid(item.qty - p.step, p.min, p.step));
      const plus = available && cartQuantityValid(item.qty + p.step, p.min, p.step) && (!variableWeight(p) || item.qty + p.step <= 100);
      return [
        { text: short(p?.name ?? 'Недоступен', 26), callback_data: p ? productData(item.productId, context) : 'cart' },
        { text: '−', ...(minus ? { callback_data: adjustData(basket.revision, item.productId, -p.step, p.unit, context) } : { disabled: {} }) },
        { text: '+', style: 'success', ...(plus ? { callback_data: adjustData(basket.revision, item.productId, p.step, p.unit, context) } : { disabled: {} }) },
        { text: '✕', style: 'danger', callback_data: shoppingData('x', basket.revision, item.productId, page) },
      ];
    });
    const itemRows = [...buttons];
    const nav: Button[] = [];
    if (page)
      nav.push({ text: '← Предыдущие', callback_data: shoppingData('k', page - 1) });
    if ((page + 1) * 5 < basket.items.length)
      nav.push({ text: 'Следующие →', callback_data: shoppingData('k', page + 1) });
    if (nav.length) buttons.push(nav);
    const checkout: Button[] = basket.items.length && basket.valid ? [{ text: '✅ Оформить заказ', style: 'success',
      callback_data: shoppingData('b', basket.revision) }] : [];
    if (basket.items.length) {
      if (checkout.length) buttons.push(checkout);
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
    const pageLabel = basket.items.length > 5 ? pageInfo(basket.items.length, page, 5).label : '';
    const total = estimate(basket.goodsTotal);
    const totalTitle = 'ИТОГО ПРЕДВАРИТЕЛЬНО';
    const promo = basket.promo ? 'Промокод: ' + basket.promo.code + ' · скидка ' + amount(basket.promo.discount) +
      '\nДо скидки: ' + estimate(basket.subtotal) : '';
    const footer = basket.items.some(item => item.product?.unit === 'GRAM' || item.product && variableWeight(item.product))
      ? 'Точная сумма весовых товаров — после сборки.' : '';
    return customerShow(target, {
      rich: { blocks: [heading('🛒 Ваша корзина'), paragraph(productCount(basket.items.length)),
        ...(pageLabel ? [paragraph(pageLabel)] : []),
        ...(feedback ? [paragraph(feedback)] : []),
        ...visible.flatMap((item, index): InputRichBlock[] => [{ type: 'divider' },
          paragraph(bold(short(item.product?.name ?? 'Товар больше недоступен', 300))),
          paragraph(itemLines[index]!.flatMap((line, lineIndex): RichText[] => [...(lineIndex ? ['\n'] : []), line])),
          { type: 'buttons', buttons: itemRows[index]!.slice(1), align: 'right' }]),
        ...(!visible.length ? [paragraph('Корзина пуста.')] : []),
        ...(nav.length ? [{ type: 'buttons' as const, buttons: nav }] : []),
        ...(basket.items.length ? [{ type: 'divider' as const }, ...(footer ? [paragraph(footer)] : []), ...(promo ? [paragraph(promo)] : []),
          { type: 'heading' as const, size: 3 as const, text: bold(totalTitle) }, { type: 'heading' as const, size: 2 as const, text: bold(total) },
          ...(checkout.length ? [{ type: 'buttons' as const, buttons: checkout }] : [])] : []),
      ] },
      fallback: [bold('🛒 Ваша корзина'), productCount(basket.items.length),
        ...[pageLabel, feedback].filter((line): line is string => Boolean(line)),
        ...visible.flatMap((item, index): RichText[] => ['', bold(short(item.product?.name ?? 'Товар больше недоступен', 300)), ...itemLines[index]!]),
        ...(!visible.length ? ['Корзина пуста.'] : ['', ...[footer, promo].filter(Boolean), '', bold(totalTitle), bold(total)])],
      text:
        '🛒 Ваша корзина\n' + productCount(basket.items.length) + (pageLabel ? '\n' + pageLabel : '') +
        (feedback ? '\n\n' + feedback : '') + '\n\n' +
        (lines.join('\n\n') || 'Корзина пуста.') +
        (footer ? '\n\n' + footer : '') + (promo ? '\n\n' + promo : '') + (basket.items.length ? '\n\n' + totalTitle + '\n' + total : ''),
      // HTML cannot interleave text and inline rows; put checkout first, directly below the total.
      richKeyboard: { inline_keyboard: buttons.slice(itemRows.length) },
      keyboard: { inline_keyboard: checkout.length ? [checkout, ...buttons.filter(row => row !== checkout)] : buttons },
    });
  }
  async present(
    target: CustomerTarget,
    identity: CustomerIdentity,
    session: CustomerTelegramSession,
  ) {
    const receiving = isReceiving(session);
    const page = receiving ? receivingPayload.parse(session.payload).page : 0;
    const addressTotal = receiving ? await this.db.address.count({ where: { userId: identity.userId } }) : 0;
    const screen = receiving ? receivingScreen(session, await this.db.address.findMany({ where: { userId: identity.userId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }], take: 6, skip: pageInfo(addressTotal, page, 6).skip }), addressTotal) : checkoutScreen(
      session,
      session.step === 'CONFIRM' ? await this.cart.get(identity.userId) : null,
      session.step === 'TIME' ? await this.orders.offer() : null,
    );
    if (!('prompt' in screen)) return customerShow(target, screen);
    const promptMessageId = await customerPrompt(target.chatId, screen.prompt);
    if (promptMessageId)
      await this.db.customerTelegramSession.updateMany({
        where: {
          id: session.id,
          identityId: identity.id,
          identity: { userId: identity.userId },
          action: session.action,
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
    browsingOnly = false,
  ) {
    if (browsingOnly && !['catalog', 'categories', 'products', 'product', 'open', 'details', 'help'].includes(action.kind))
      throw new BadRequestException('Для покупок подтвердите свой номер Telegram.');
    switch (action.kind) {
      case 'catalog':
        return this.categories(target);
      case 'categories':
        return this.categories(target, action.page);
      case 'products':
        return this.products(target, identity, action.categoryId, action.page, { browsingOnly });
      case 'product':
        return this.product(target, identity, action.productId, { browsingOnly });
      case 'open':
      case 'details':
        return this.product(target, identity, action.productId, { browsingOnly, context: action, details: action.kind === 'details' });
      case 'adjust':
        return this.adjust(target, identity, action);
      case 'cart':
        return this.basket(target, identity);
      case 'basket':
        return this.basket(target, identity, action.page);
      case 'quick':
        return this.quickShop(target, identity, action.page);
      case 'receiving':
        return this.present(target, identity, await this.checkout.receiving(identity));
      case 'receive':
        return this.present(target, identity, await this.checkout.chooseReceiving(identity, action));
      case 'repeat': {
        const result = await this.quick.repeat(identity.userId, action.revision, action.orderId);
        return this.basket(target, identity, 0, result.cart, 'Добавлено позиций: ' + result.added +
          (result.skipped.length ? '. Пропущено: ' + result.skipped.length + '. Уже выбранные количества сохранены.' : '. Проверьте состав перед оформлением.'));
      }
      case 'add': {
        const before = await this.cart.get(identity.userId);
        const basket = await this.cart.change(identity.userId, action.revision, action);
        return this.product(target, identity, action.productId, { basket, feedback: before.revision === action.revision
          ? cartFeedback(before, basket, action.productId) : '✅ Количество обновлено\nСтоимость пересчитана' });
      }
      case 'clear': {
        const basket = await this.cart.get(identity.userId);
        if (basket.revision !== action.revision) throw new ConflictException('Корзина уже изменилась. Откройте её заново.');
        return customerShow(target, clearCartScreen(basket));
      }
      case 'plus':
      case 'minus':
      case 'remove':
      case 'clearConfirmed': {
        const before = action.kind === 'clearConfirmed' ? null : await this.cart.get(identity.userId);
        const basket = await this.cart.change(
          identity.userId,
          action.revision,
          action.kind === 'clearConfirmed' ? { kind: 'clear' } : action,
        );
        return this.basket(target, identity, action.kind === 'remove' ? action.page ?? 0 : 0, basket,
          before && action.kind !== 'clearConfirmed' ? before.revision === action.revision
            ? cartFeedback(before, basket, action.productId) : '✅ Количество обновлено\nСтоимость пересчитана' : undefined);
      }
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
              '\nПредварительная сумма товаров: ' +
              estimate(order.subtotal) +
              '\n\nОткройте заказ, чтобы следить за сборкой, отвечать на вопросы и увидеть итоговую сумму.',
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
                [{ text: 'В магазин', callback_data: 'catalog' }, { text: 'Меню', callback_data: 'menu' }],
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
        return customerShow(target, shoppingHelpScreen());
      case 'resume':
        return;
    }
  }
}
