import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { cartProductSelect, cartQuantityValid, cartQuote } from '../order/cart-quote.js';
import { orderableProductWhere } from '../product/select.js';
import { priceUnit, saleModel, variableWeight } from '../product/sale.js';
import { CartService } from './cart.service.js';

const limit = 24;
const previousItemSelect = {
  productId: true, productName: true, qty: true, unit: true, priceUnit: true,
  saleModel: true, weightMinGrams: true, weightMaxGrams: true,
} as const;

@Injectable()
export class QuickShopService {
  constructor(private readonly db: DbService, private readonly cart: CartService) {}

  async get(userId: number) {
    const [cart, history, favorites, lastOrder] = await Promise.all([
      this.cart.get(userId),
      this.db.order.findMany({
        where: { userId, status: 'COMPLETED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30,
        select: { items: {
          where: { status: 'PICKED', productId: { not: null } },
          orderBy: { id: 'asc' }, take: 50, select: previousItemSelect,
        } },
      }),
      this.db.favorite.findMany({
        where: { userId }, orderBy: [{ createdAt: 'desc' }, { productId: 'asc' }],
        take: limit, select: { productId: true },
      }),
      this.db.order.findFirst({
        where: { userId, status: { not: 'CANCELED' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, createdAt: true, _count: { select: {
          items: { where: { status: { not: 'MISSING' } } },
        } } },
      }),
    ]);
    const frequent = new Map<number, { count: number; item: (typeof history)[number]['items'][number] }>();
    for (const order of history) {
      const seen = new Set<number>();
      for (const item of order.items) {
        if (item.productId === null || seen.has(item.productId)) continue;
        seen.add(item.productId);
        const previous = frequent.get(item.productId);
        if (previous) previous.count++;
        else frequent.set(item.productId, { count: 1, item });
      }
    }
    // Frequency ties retain the most recently ordered product, then its stable item order.
    const ranked = [...frequent].sort((a, b) => b[1].count - a[1].count).slice(0, limit);
    const favoriteIds = new Set(favorites.map(item => item.productId));
    const ids = [...new Set([...ranked.map(([id]) => id), ...favoriteIds])];
    const personalized = ids.length ? await this.db.product.findMany({
      where: { ...orderableProductWhere, id: { in: ids } }, select: cartProductSelect, take: limit * 2,
    }) : [];
    const rank = new Map(ids.map((id, index) => [id, index]));
    personalized.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const chosen = personalized.slice(0, limit);
    if (chosen.length < limit) chosen.push(...await this.db.product.findMany({
      where: { ...orderableProductWhere, id: { notIn: chosen.map(item => item.id) } },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }], take: limit - chosen.length, select: cartProductSelect,
    }));
    const quantities = chosen.map(product => {
      const previous = frequent.get(product.id)?.item;
      const same = previous && previous.unit === product.unit &&
        priceUnit(previous) === priceUnit(product) && saleModel(previous) === saleModel(product);
      const defaultQty = cartQuantityValid(product.portionQty, product.min, product.step) &&
        (!variableWeight(product) || product.portionQty <= 100) ? product.portionQty : product.min;
      const qty = same && cartQuantityValid(previous.qty, product.min, product.step) &&
        (!variableWeight(product) || previous.qty <= 100) ? previous.qty : defaultQty;
      return { productId: product.id, qty, quantityUnit: product.unit };
    });
    const quote = cartQuote(new Map(quantities.map(item => [item.productId, item.qty])), chosen, quantities);
    return {
      cart,
      items: quote.items.flatMap(item => item.product && item.status === 'AVAILABLE' ? [{
        product: item.product,
        source: frequent.has(item.productId) ? 'frequent' as const :
          favoriteIds.has(item.productId) ? 'favorite' as const : 'catalog' as const,
        suggestedQty: item.qty, lineTotal: item.lineTotal,
      }] : []),
      lastOrder: lastOrder ? { id: lastOrder.id, createdAt: lastOrder.createdAt,
        itemCount: lastOrder._count.items } : null,
    };
  }

  async repeat(userId: number, revision: string, orderId?: number) {
    const order = await this.db.order.findFirst({
      where: { userId, status: { not: 'CANCELED' }, ...(orderId === undefined ? {} : { id: orderId }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, items: {
        where: { status: { not: 'MISSING' } }, orderBy: { id: 'asc' }, take: 51, select: previousItemSelect,
      } },
    });
    if (!order) throw new NotFoundException('Заказ для повтора не найден');
    const cart = await this.cart.get(userId);
    if (cart.revision !== revision) throw new ConflictException('Корзина уже изменилась. Обновите её.');
    const existing = new Set(cart.items.map(item => item.productId));
    const ids = [...new Set(order.items.flatMap(item => item.productId === null ? [] : [item.productId]))];
    const products = ids.length ? await this.db.product.findMany({
      where: { ...orderableProductWhere, id: { in: ids } }, select: cartProductSelect,
    }) : [];
    const byId = new Map(products.map(product => [product.id, product]));
    const additions: Parameters<CartService['merge']>[2] = [];
    const skipped: { productId: number | null; name: string; reason: string }[] = [];
    const seen = new Set<number>();
    for (const item of order.items) {
      const product = item.productId === null ? undefined : byId.get(item.productId);
      let reason: string | undefined;
      if (item.productId !== null && (existing.has(item.productId) || seen.has(item.productId)))
        reason = 'Уже есть в корзине: количество сохранено';
      else if (!product) reason = 'Товар больше недоступен';
      else if (item.unit !== product.unit || priceUnit(item) !== priceUnit(product) || saleModel(item) !== saleModel(product))
        reason = 'Способ продажи изменился: выберите количество заново';
      else if (!cartQuantityValid(item.qty, product.min, product.step) || (variableWeight(product) && item.qty > 100))
        reason = 'Изменились допустимое количество или шаг продажи';
      else if (existing.size + additions.length >= 50) reason = 'В корзине не больше 50 товаров';
      if (reason || !product) {
        skipped.push({ productId: item.productId, name: item.productName, reason: reason! });
        continue;
      }
      seen.add(product.id);
      additions.push({ productId: product.id, qty: item.qty, quantityUnit: product.unit,
        ...(variableWeight(product) ? { weightMinGrams: item.weightMinGrams, weightMaxGrams: item.weightMaxGrams } : {}) });
    }
    // merge rechecks revision, current product terms and availability under its normal locks.
    // It preserves existing lines and does not create an order or consume a promotion.
    const updated = await this.cart.merge(userId, revision, additions, additions.map(item => {
      const product = byId.get(item.productId)!;
      return { productId: product.id, unit: product.unit,
        priceUnit: priceUnit(product), saleModel: saleModel(product) };
    }));
    return { cart: updated, orderId: order.id, added: additions.length, skipped };
  }
}
