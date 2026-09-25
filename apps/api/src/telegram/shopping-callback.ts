import { z } from 'zod';
const id = z.number().int().positive().max(2147483647);
const page = z.number().int().min(0).max(10000);
const qty = z.number().int().positive().max(1000000);
function number(value: string | undefined, schema: z.ZodNumber) {
  if (!value || !/^(0|[1-9a-z][0-9a-z]{0,5})$/.test(value)) return null;
  const result = schema.safeParse(Number.parseInt(value, 36));
  return result.success ? result.data : null;
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
  | { kind: 'products'; categoryId: number; page: number }
  | { kind: 'product'; productId: number; qty: number }
  | { kind: 'add'; productId: number; qty: number; revision: string }
  | { kind: 'plus' | 'minus' | 'remove'; productId: number; revision: string }
  | { kind: 'clear'; revision: string }
  | { kind: 'checkout'; revision: string }
  | {
      kind: 'flow';
      revision: string;
      choice:
        'pickup' | 'delivery' | 'saved' | 'new' | 'confirm' | 'edit' | 'cancel';
    }
  | {
      kind: 'pay' | 'paid';
      publicId: string;
      method: 'SBP' | 'CARD_TRANSFER' | 'QR';
    };
export function shoppingAction(data: string): ShoppingAction | null {
  if (Buffer.byteLength(data, 'utf8') > 64) return null;
  if (
    data === 'catalog' ||
    data === 'cart' ||
    data === 'resume' ||
    data === 'help'
  )
    return { kind: data };
  const [prefix, action, a, b, c, ...extra] = data.split(':');
  if (prefix !== 's' || extra.length) return null;
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
    const productId = number(b, id),
      q = number(c, qty);
    return rev && productId && q
      ? { kind: 'add', productId, qty: q, revision: rev }
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
  if ((action === 'z' || action === 'b') && b === undefined && rev)
    return { kind: action === 'z' ? 'clear' : 'checkout', revision: rev };
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
