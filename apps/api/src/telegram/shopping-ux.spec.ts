import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { CartService, CartChange } from '../cart/cart.service.js';
import type { QuickShopService } from '../cart/quick-shop.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerShopService } from './customer-shop.service.js';
import { customerShow } from './customer-send.js';
import { shoppingAction, type ShoppingAction } from './shopping-callback.js';
import { cartQuantityValid } from '../order/cart-quote.js';
import { requestedLine } from '../order/pricing.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { richMessage, validScreen } from './rich.js';

vi.mock('./customer-send.js', () => ({ customerShow: vi.fn(async () => true), customerPrompt: vi.fn() }));
const target = { chatId: 70001, messageId: 90 }, identity = { id: 3, userId: 7 };
const dill = { id: 11, name: 'Укроп', slug: 'dill', description: 'Свежая зелень <script>не HTML</script>',
  unit: 'BUNCH' as const, priceUnit: 'BUNCH' as const, saleModel: 'BUNCH' as const,
  price: 16500, priceQty: 1, priceStatus: 'SOURCE' as const, serviceMarkupPercent: 0,
  min: 1, step: 1, portionQty: 1, estimatedWeightGrams: null as number | null,
  marketPoint: null, categoryId: 2, images: [{ url: '/uploads/products/fixture.webp', alt: 'Укроп' }] };
type Source = Omit<typeof dill, 'unit' | 'priceUnit' | 'saleModel' | 'priceStatus'> & {
  priceStatus: 'SOURCE' | 'ESTIMATED';
  unit: 'BUNCH' | 'GRAM' | 'PIECE'; priceUnit: 'BUNCH' | 'GRAM' | 'PIECE'; saleModel: 'BUNCH' | 'WEIGHT_LOOSE' | 'WHOLE_VARIABLE_WEIGHT';
};
function setup(product: Source = dill, initial = 0) {
  let revision = randomUUID(), qty = initial, lost = false;
  const snapshot = () => ({ revision, items: qty ? [{ productId: product.id, qty, quantityUnit: product.unit,
    status: 'AVAILABLE' as const, product: { ...product }, lineTotal: requestedLine({ ...product, qty }) }] : [],
    goodsTotal: qty ? requestedLine({ ...product, qty }) : 0, subtotal: qty ? requestedLine({ ...product, qty }) : 0, valid: true, promo: null });
  const db = { product: { findFirst: vi.fn(async () => product), count: vi.fn(async () => 37),
    findMany: vi.fn(async ({ skip = 0, take = 8 }: { skip?: number; take?: number }) => Array.from({ length: Math.min(take, 37 - skip) }, (_, i) => ({ ...product, id: skip + i + 1 }))) },
    category: { count: vi.fn(async () => 27), findFirst: vi.fn(async () => ({ name: 'Зелень' })),
      findMany: vi.fn(async ({ skip = 0, take = 27 }: { skip?: number; take?: number }) => Array.from({ length: Math.min(take, 27 - skip) }, (_, i) => ({ id: skip + i + 1, name: 'Категория ' + (skip + i + 1) }))) },
    $transaction: vi.fn() };
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  const cart = { get: vi.fn(async () => snapshot()), change: vi.fn(async (owner: number, expected: string, change: CartChange) => {
    expect(owner).toBe(7);
    if (revision !== expected) throw new ConflictException('STALE_CART');
    if (change.kind === 'remove') qty = 0;
    else if (change.kind === 'set' && cartQuantityValid(change.qty, product.min, product.step) &&
      (product.saleModel !== 'WHOLE_VARIABLE_WEIGHT' || change.qty <= 100) && change.quantityUnit === product.unit) qty = change.qty;
    else throw new Error('Invalid fixture mutation');
    revision = randomUUID(); if (lost) { lost = false; throw new Error('Lost response after commit'); }
    return snapshot();
  }) };
  const quick = { get: vi.fn(async () => ({ items: [{ product, lineTotal: 16500 }], cart: snapshot(), lastOrder: { id: 42 } })),
    repeat: vi.fn(async () => ({ cart: snapshot(), added: 1, skipped: [] })) };
  const service = new CustomerShopService(db as unknown as DbService, cart as unknown as CartService,
    {} as CustomerCheckoutService, {} as OrderService, quick as unknown as QuickShopService);
  return { service, db, cart, quick, snapshot, loseNextResponse() { lost = true; } };
}
const screen = () => vi.mocked(customerShow).mock.calls.at(-1)![1];
const actions = () => screen().keyboard.inline_keyboard.flat().flatMap(button => 'callback_data' in button ? [shoppingAction(button.callback_data)] : []);
function adjustment(delta: number) {
  const action = actions().find((action): action is Extract<ShoppingAction, { kind: 'adjust' }> => action?.kind === 'adjust' && action.delta === delta);
  if (!action) throw new Error('Immediate adjustment missing: ' + delta);
  return action;
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(() => vi.unstubAllEnvs());

it('executes 0 → +1 → +2 → −1 → +2 as 1/3/2/4, and keeps 4 across basket and product navigation', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 2, origin: 'category' });
  for (const [delta, qty] of [[1,1], [2,3], [-1,2], [2,4]] as const) {
    const action = adjustment(delta);
    await s.service.handle(target, identity, action);
    expect(s.snapshot().items[0]?.qty).toBe(qty);
    expect(screen().text).toContain('В корзине этого товара: ' + qty + (qty === 1 ? ' пучок' : ' пучка'));
    expect(adjustment(1).revision).toBe(s.snapshot().revision);
    expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:2:2' });
  }
  expect(screen().text).toContain('✅ Добавлено 2 пучка · 330 ₽');
  await s.service.basket(target, identity);
  expect(screen().text).toContain('4 пучка · ≈ 660 ₽');
  const open = actions().find(action => action?.kind === 'open'); if (!open) throw new Error('Open action missing');
  await s.service.handle(target, identity, open);
  expect(screen().text).toContain('В корзине этого товара: 4 пучка');
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К корзине', callback_data: 's:k:0' });
  expect(s.cart.change).toHaveBeenCalledTimes(4);
});
it('removes the final bunch immediately and never creates a zero-quantity line', async () => {
  const s = setup(dill, 1);
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  await s.service.handle(target, identity, adjustment(-1));
  expect(s.snapshot().items).toEqual([]);
  expect(s.cart.change).toHaveBeenCalledWith(7, expect.any(String), { kind: 'remove', productId: 11 });
});
it('labels estimated fixed-unit action prices and receipts as preliminary', async () => {
  const s = setup({ ...dill, priceStatus: 'ESTIMATED' });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('+1 пучок · ≈ 165 ₽');
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ Добавлено 1 пучок · ≈ 165 ₽');
});
it('does not reapply an old button after success and refreshes it without a false success receipt', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  const old = adjustment(2);
  await s.service.handle(target, identity, old);
  await expect(s.service.handle(target, identity, old)).rejects.toBeInstanceOf(ConflictException);
  expect(s.snapshot().items[0]?.qty).toBe(2); expect(s.cart.change).toHaveBeenCalledTimes(1);
  expect(screen().text).toContain('Старое действие не применено'); expect(screen().text).not.toContain('✅ Добавлено');
});
it('reads after a lost write response, with no blind replay or invented receipt', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  s.loseNextResponse(); await expect(s.service.handle(target, identity, adjustment(2))).rejects.toThrow('Lost response');
  expect(s.cart.change).toHaveBeenCalledTimes(1); expect(s.snapshot().items[0]?.qty).toBe(2);
  expect(screen().text).toContain('Корзина перечитана'); expect(screen().text).not.toContain('✅ Добавлено');
  expect(adjustment(1).revision).toBe(s.snapshot().revision);
});
it('uses configured weight steps and server line rounding for immediate action estimates', async () => {
  const s = setup({ ...dill, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', min: 500, step: 500, priceQty: 1000, price: 29000 });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toEqual(expect.arrayContaining(['+500 г · ≈ 145 ₽', '+1 кг · ≈ 290 ₽']));
  await s.service.handle(target, identity, adjustment(500)); expect(s.snapshot().items[0]?.qty).toBe(500);
});
it('keeps whole goods in pieces with unknown prices and requests media only on explicit details', async () => {
  const s = setup({ ...dill, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000, price: 77000 });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 1, origin: 'category' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('+1 шт. · После взвешивания');
  expect(screen().rich?.blocks.some(block => block.type === 'photo')).toBe(false);
  expect(adjustment(2).quantityUnit).toBe('PIECE');
  await s.service.handle(target, identity, { kind: 'details', productId: 11, page: 1, origin: 'category' });
  expect(screen().rich?.blocks.some(block => block.type === 'photo')).toBe(true);
  expect(screen().rich?.blocks.some(block => block.type === 'details')).toBe(true);
  expect(s.cart.change).not.toHaveBeenCalled();
});
it('counts available categories on the server, clamps pages and lays them out in two columns', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'categories', page: 9999 });
  expect(screen().text).toContain('Страница 4 из 4');
  expect(screen().keyboard.inline_keyboard[0]).toHaveLength(2);
  expect(s.db.category.count).toHaveBeenCalledWith({ where: { active: true, products: { some: { active: true } } } });
  expect(s.db.category.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 24, take: 8 }));
});
it('shows product ranges/counts and retains the originating category page', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'products', categoryId: 2, page: 1 });
  expect(screen().text).toContain('Страница 2 из 5'); expect(screen().text).toContain('Показаны товары 9–16 из 37');
  const open = actions().find(action => action?.kind === 'open' && action.productId === 11); if (!open) throw new Error('Product missing');
  await s.service.handle(target, identity, open);
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:2:1' });
});
it('opens native quick shopping and repeats only on an explicit versioned callback', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'quick', page: 0 });
  expect(s.quick.repeat).not.toHaveBeenCalled();
  const repeat = actions().find(action => action?.kind === 'repeat'); if (!repeat) throw new Error('Repeat missing');
  await s.service.handle(target, identity, repeat);
  expect(s.quick.repeat).toHaveBeenCalledWith(7, repeat.revision, 42);
  expect(screen().text).toContain('Добавлено позиций: 1');
});

it('keeps representative shopping screens and Rich payloads within Telegram limits', async () => {
  const s = setup(dill, 6);
  const examples: { id: string; text: string; rich_message: ReturnType<typeof richMessage> }[] = [];
  const save = (id: string) => {
    expect(validScreen(screen())).toBe(true);
    for (const button of screen().keyboard.inline_keyboard.flat()) if ('callback_data' in button)
      expect(shoppingAction(button.callback_data) ?? ['menu', 'cart', 'catalog'].includes(button.callback_data)).toBeTruthy();
    examples.push({ id, ...screen(), rich_message: richMessage(screen()) });
  };
  for (const action of [{ kind: 'catalog' }, { kind: 'products', categoryId: 2, page: 1 },
    { kind: 'open', productId: 11, page: 1, origin: 'category' },
    { kind: 'details', productId: 11, page: 1, origin: 'category' },
    { kind: 'cart' }, { kind: 'quick', page: 0 }] as const) {
    await s.service.handle(target, identity, action); save('shopping-' + action.kind);
  }
  for (const product of [
    { ...dill, unit: 'GRAM' as const, priceUnit: 'GRAM' as const, saleModel: 'WEIGHT_LOOSE' as const, min: 500, step: 500, priceQty: 1000, price: 29000 },
    { ...dill, unit: 'PIECE' as const, priceUnit: 'GRAM' as const, saleModel: 'WHOLE_VARIABLE_WEIGHT' as const, priceQty: 1000, price: 77000, estimatedWeightGrams: 1200 },
  ]) {
    const other = setup(product);
    await other.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
    save('shopping-' + product.saleModel);
  }
  if (process.env.TELEGRAM_PREMIUM_SNAPSHOTS === '1')
    writeFileSync(resolve('../../work/telegram-ux2/shopping-screens.json'), JSON.stringify(examples, null, 2) + '\n');
});
