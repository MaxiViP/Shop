import type { QuickShopSuggestion } from '../types/quick-shop';
import type { CartItem, CartQuoteLine, ServerCartChange } from './cart';
import { validCartQty } from './cart.ts';
import type { ProductListItem } from '../types/product';
import { qtyText } from './qty.ts';
import { money } from './money.ts';
import { priceUnit, saleModel, variableWeight } from './sale.ts';

export type QuickShopFilter = 'all' | 'favorites' | 'cart';
export interface QuickShopRow {
  product: ProductListItem;
  suggestedQty: number;
  suggestedTotal: number | null;
  line: CartQuoteLine | undefined;
}

export interface QuickShopContext {
  filter: QuickShopFilter;
  query: string;
  scroll: number;
}

// This cache contains navigation only. Prices and quantities always come from
// the current server cart after returning to the page.
export function quickShopContext(raw: string | null): QuickShopContext | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || !['all', 'favorites', 'cart'].includes(String(data.filter)) ||
      typeof data.query !== 'string' || data.query.length > 100 || typeof data.scroll !== 'number' ||
      !Number.isFinite(data.scroll) || data.scroll < 0 || data.scroll > 1_000_000) return null;
    return { filter: data.filter as QuickShopFilter, query: data.query, scroll: data.scroll };
  } catch { return null; }
}

export function quickShopOrderId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return id <= 2_147_483_647 ? id : null;
}

export interface QuickShopUndo {
  productId: number;
  before: CartQuoteLine | undefined;
  after: CartQuoteLine | undefined;
}

function sameSelection(a: CartQuoteLine | undefined, b: CartQuoteLine | undefined): boolean {
  if (!a || !b) return a === b;
  return a.qty === b.qty && (a.quantityUnit ?? a.product?.unit) === (b.quantityUnit ?? b.product?.unit) &&
    (a.weightMinGrams ?? null) === (b.weightMinGrams ?? null) && (a.weightMaxGrams ?? null) === (b.weightMaxGrams ?? null) &&
    Boolean(a.product && b.product && saleModel(a.product) === saleModel(b.product) && priceUnit(a.product) === priceUnit(b.product));
}

// Undo changes one product using the store's current revision. It must never
// restore an entire old basket or overwrite an intervening edit to this item.
export function quickShopUndo(change: QuickShopUndo, current: CartQuoteLine | undefined): ServerCartChange | null {
  const { before, after, productId } = change;
  if ([before, after, current].some(line => line && line.productId !== productId) ||
    (before?.qty ?? 0) === (after?.qty ?? 0) || !sameSelection(after, current) ||
    (current && current.status !== 'AVAILABLE')) return null;
  if (!before) return { kind: 'remove', productId };
  const product = current?.product ?? before.product;
  if (!product || !before.product || before.status !== 'AVAILABLE' ||
    (before.quantityUnit ?? before.product.unit) !== product.unit ||
    saleModel(before.product) !== saleModel(product) || priceUnit(before.product) !== priceUnit(product) ||
    !validCartQty(before.qty, product)) return null;
  return { kind: 'set', productId, qty: before.qty, quantityUnit: product.unit,
    ...(variableWeight(product) ? { weightMinGrams: before.weightMinGrams ?? null, weightMaxGrams: before.weightMaxGrams ?? null } : {}) };
}

export function quickShopRows(
  suggestions: QuickShopSuggestion[],
  items: CartItem[],
  lines: CartQuoteLine[],
  filter: QuickShopFilter,
  favoriteIds: readonly number[],
): QuickShopRow[] {
  const rows = new Map<number, QuickShopRow>();
  for (const item of suggestions) rows.set(item.product.id, {
    product: item.product, suggestedQty: item.suggestedQty,
    suggestedTotal: item.lineTotal, line: lines.find(line => line.productId === item.product.id),
  });
  for (const item of items) {
    const existing = rows.get(item.product.id);
    rows.set(item.product.id, {
      product: item.product,
      suggestedQty: existing?.suggestedQty ?? item.product.portionQty,
      suggestedTotal: existing?.suggestedTotal ?? null,
      line: lines.find(line => line.productId === item.product.id),
    });
  }
  const selected = new Set(items.map(item => item.product.id));
  const favorites = new Set(favoriteIds);
  for (const item of suggestions) if (item.source === 'favorite') favorites.add(item.product.id);
  return [...rows.values()].filter(row => filter === 'cart' ? selected.has(row.product.id)
    : filter === 'favorites' ? favorites.has(row.product.id) : true);
}

// Both amounts must come from acknowledged server snapshots. A price or sale-unit
// change is never presented as the cost of the buyer's quantity change alone.
export function quickShopChange(
  product: ProductListItem,
  before: CartQuoteLine | undefined,
  after: CartQuoteLine | undefined,
): string {
  if (before && after && (
    (before.quantityUnit ?? before.product?.unit) !== (after.quantityUnit ?? after.product?.unit) ||
    (before.product && after.product && (saleModel(before.product) !== saleModel(after.product) ||
      priceUnit(before.product) !== priceUnit(after.product)))
  )) return 'Условия товара изменились; проверьте количество и стоимость в корзине.';
  const oldQty = before?.qty ?? 0, qty = after?.qty ?? 0;
  const delta = qty - oldQty;
  if (!delta) return 'Корзина обновлена. Проверьте актуальную стоимость.';
  const label = qtyText(product.unit, Math.abs(delta), product);
  const oldTotal = before ? before.lineTotal : 0, total = after ? after.lineTotal : 0;
  const samePrice = !before?.product || !after?.product || (
    before.product.price === after.product.price && before.product.priceQty === after.product.priceQty &&
    before.product.unit === after.product.unit && priceUnit(before.product) === priceUnit(after.product) &&
    before.product.estimatedWeightGrams === after.product.estimatedWeightGrams
  );
  const amount = oldTotal !== null && total !== null && samePrice
    ? ` · ${total >= oldTotal ? '+' : '−'}${money(Math.abs(total - oldTotal))}` : '';
  return `${product.name}: ${delta > 0 ? 'добавлено +' : 'убрано '}${label}${amount}. ` +
    (qty ? `В корзине ${qtyText(product.unit, qty, product)}.` : 'Товар удалён из корзины.');
}
