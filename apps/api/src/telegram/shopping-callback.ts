import { z } from 'zod';
import type { SaleUnit } from '../product/sale.js';
const id = z.number().int().positive().max(2147483647);
const page = z.number().int().min(0).max(10000);
const qty = z.number().int().positive().max(1000000);
const unitCodes: Record<SaleUnit, string> = { GRAM: 'g', PIECE: 'p', BUNCH: 'b', PACK: 'k' };
function quantityUnit(value: string | undefined): SaleUnit | null {
  switch (value) {
    case 'GRAM': case 'g': return 'GRAM';
    case 'PIECE': case 'p': return 'PIECE';
    case 'BUNCH': case 'b': return 'BUNCH';
    case 'PACK': case 'k': return 'PACK';
    default: return null;
  }
}
function number(value: string | undefined, schema: z.ZodNumber) {
  if (!value || !/^(0|[1-9a-z][0-9a-z]{0,5})$/.test(value)) return null;
  const result = schema.safeParse(Number.parseInt(value, 36));
  return result.success ? result.data : null;
}
function shopContext(value: string | undefined, page: number): ShopContext | null {
  if (value === 'k' || value === 'q' || value === 'c') return { page, origin: value === 'k' ? 'basket' : value === 'q' ? 'quick' : 'category' };
  const categoryId = value?.startsWith('c') ? number(value.slice(1), id) : null;
  return categoryId ? { page, origin: 'category', categoryId } : null;
}
function contextCode(context: ShopContext) {
  return context.origin === 'basket' ? 'k' : context.origin === 'quick' ? 'q' :
    'c' + (context.categoryId === undefined ? '' : context.categoryId.toString(36));
}
export const compact = (value: string) => value.replaceAll('-', '');
export function expand(value: string | undefined) {
  if (!value || !/^[0-9a-f]{32}$/.test(value)) return null;
  return (
    value.slice(0, 8) +
    '-' +
    value.slice(8, 12) +
    '-' +
    value.slice(12, 16) +
    '-' +
    value.slice(16, 20) +
    '-' +
    value.slice(20)
  );
}
export type ShoppingAction =
  | { kind: 'catalog' | 'cart' | 'resume' | 'help' }
  | { kind: 'categories' | 'basket'; page: number }
  | { kind: 'quick'; page: number }
  | { kind: 'receiving' }
  | { kind: 'receive'; revision: string; choice: 'pickup' | 'delivery' | 'view' | 'use' | 'edit' | 'new' | 'save' | 'page'; value?: number }
  | { kind: 'repeat'; revision: string; orderId: number }
  | { kind: 'products'; categoryId: number; page: number }
  | { kind: 'product'; productId: number; qty: number }
  | ({ kind: 'open' | 'details'; productId: number } & ShopContext)
  | ({ kind: 'adjust'; productId: number; delta: number; quantityUnit: SaleUnit; revision: string } & ShopContext)
  | { kind: 'add'; productId: number; qty: number; revision: string; quantityUnit?: SaleUnit }
  | { kind: 'plus' | 'minus' | 'remove'; productId: number; revision: string; page?: number }
  | { kind: 'clear'; revision: string }
  | { kind: 'clearConfirmed'; revision: string }
  | { kind: 'checkout'; revision: string }
  | {
      kind: 'flow';
      revision: string;
      choice:
        'pickup' | 'delivery' | 'saved' | 'new' | 'confirm' | 'edit' | 'cancel' |
        'edit_name' | 'edit_phone' | 'edit_type' | 'edit_address' | 'edit_comment' | 'edit_time' | 'edit_done';
    }
  | {
      kind: 'pay' | 'paid';
      publicId: string;
      method: 'SBP' | 'CARD_TRANSFER' | 'QR';
    };
export function shoppingAction(data: string): ShoppingAction | null {
  if (Buffer.byteLength(data, 'utf8') > 64) return null;
  if (data === 'quick') return { kind: 'quick', page: 0 };
  if (data === 'delivery') return { kind: 'receiving' };
  if (
    data === 'catalog' ||
    data === 'cart' ||
    data === 'resume' ||
    data === 'help'
  )
    return { kind: data };
  const parts = data.split(':');
  if (parts[0] === 's' && parts[1] === 'g' && (parts.length === 4 || parts.length === 5)) {
    const revision = expand(parts[2]), choice = parts[3];
    if (!revision) return null;
    if ((choice === 'view' || choice === 'page') && parts.length === 5) {
      const value = number(parts[4], choice === 'page' ? page : id);
      return value === null ? null : { kind: 'receive', revision, choice, value };
    }
    if (parts.length === 4 && (choice === 'pickup' || choice === 'delivery' || choice === 'use' || choice === 'edit' || choice === 'new' || choice === 'save'))
      return { kind: 'receive', revision, choice };
    return null;
  }
  if (parts[0] === 's' && parts[1] === 'x' && parts.length === 5) {
    const revision = expand(parts[2]), productId = number(parts[3], id), p = number(parts[4], page);
    return revision && productId && p !== null ? { kind: 'remove', revision, productId, page: p } : null;
  }
  if (parts[0] === 's' && parts[1] === 'q' && parts.length === 3) {
    const p = number(parts[2], page);
    return p === null ? null : { kind: 'quick', page: p };
  }
  if (parts[0] === 's' && parts[1] === 'e' && parts.length === 4) {
    const revision = expand(parts[2]), orderId = number(parts[3], id);
    return revision && orderId ? { kind: 'repeat', revision, orderId } : null;
  }
  if (parts[0] === 's' && ['o', 'd'].includes(parts[1] ?? '') && parts.length === 5) {
    const productId = number(parts[2], id), p = number(parts[3], page), origin = parts[4];
    const context = p === null ? null : shopContext(origin, p);
    return productId && context ? {
      kind: parts[1] === 'o' ? 'open' : 'details', productId, ...context,
    } : null;
  }
  if (parts[0] === 's' && parts[1] === 'u' && parts.length === 8) {
    const revision = expand(parts[2]), productId = number(parts[3], id), value = parts[4] ?? '';
    const delta = /^[pm]/.test(value) ? number(value.slice(1), qty) : null;
    const unit = quantityUnit(parts[5]), p = number(parts[6], page), origin = parts[7];
    const context = p === null ? null : shopContext(origin, p);
    return revision && productId && delta && context && unit ? {
        kind: 'adjust', productId, delta: value[0] === 'm' ? -delta : delta, revision,
        quantityUnit: unit, ...context,
      } : null;
  }
  const [prefix, action, a, b, c, unit, ...extra] = data.split(':');
  if (prefix !== 's' || extra.length || (unit !== undefined && action !== 'a')) return null;
  const rev = expand(a);
  if ((action === 'c' || action === 'k') && b === undefined) {
    const p = number(a, page);
    return p === null
      ? null
      : { kind: action === 'c' ? 'categories' : 'basket', page: p };
  }
  if (action === 'l' && c === undefined) {
    const categoryId = number(a, id),
      p = number(b, page);
    return categoryId && p !== null
      ? { kind: 'products', categoryId, page: p }
      : null;
  }
  if (action === 'v' && c === undefined) {
    const productId = number(a, id),
      q = number(b, qty);
    return productId && q ? { kind: 'product', productId, qty: q } : null;
  }
  if (action === 'a') {
    if (unit !== undefined && !['GRAM', 'PIECE', 'BUNCH', 'PACK'].includes(unit)) return null;
    const productId = number(b, id),
      q = number(c, qty);
    return rev && productId && q
      ? { kind: 'add', productId, qty: q, revision: rev,
          ...(unit ? { quantityUnit: unit as SaleUnit } : {}) }
      : null;
  }
  if (['+', '-', 'x'].includes(action ?? '') && c === undefined) {
    const productId = number(b, id);
    return rev && productId
      ? {
          kind: action === '+' ? 'plus' : action === '-' ? 'minus' : 'remove',
          productId,
          revision: rev,
        }
      : null;
  }
  if (['z', 'y', 'b'].includes(action ?? '') && b === undefined && rev)
    return { kind: action === 'z' ? 'clear' : action === 'y' ? 'clearConfirmed' : 'checkout', revision: rev };
  if (
    action === 'f' &&
    c === undefined &&
    rev &&
    [
      'pickup',
      'delivery',
      'saved',
      'new',
      'confirm',
      'edit',
      'cancel',
      'edit_name',
      'edit_phone',
      'edit_type',
      'edit_address',
      'edit_comment',
      'edit_time',
      'edit_done',
    ].includes(b ?? '')
  )
    return {
      kind: 'flow',
      revision: rev,
      choice: b as Extract<ShoppingAction, { kind: 'flow' }>['choice'],
    };
  if (
    (action === 'p' || action === 'r') &&
    c === undefined &&
    rev &&
    ['SBP', 'CARD_TRANSFER', 'QR'].includes(b ?? '')
  )
    return {
      kind: action === 'p' ? 'pay' : 'paid',
      publicId: rev,
      method: b as 'SBP' | 'CARD_TRANSFER' | 'QR',
    };
  return null;
}
export const shoppingData = (action: string, ...values: (number | string)[]) =>
  's:' +
  action +
  ':' +
  values
    .map((value) =>
      typeof value === 'number' ? value.toString(36) : compact(value),
    )
    .join(':');

export type ShopContext = { page: number; origin: 'category' | 'basket' | 'quick'; categoryId?: number };
export function productData(productId: number, context: ShopContext, details = false) {
  return shoppingData(details ? 'd' : 'o', productId, context.page, contextCode(context));
}
export function adjustData(revision: string, productId: number, delta: number, unit: SaleUnit, context: ShopContext) {
  return shoppingData('u', revision, productId, (delta < 0 ? 'm' : 'p') + Math.abs(delta).toString(36),
    context.origin === 'category' && context.categoryId !== undefined ? unitCodes[unit] : unit, context.page, contextCode(context));
}
