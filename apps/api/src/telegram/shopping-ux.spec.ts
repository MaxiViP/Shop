import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { CartService, CartChange } from '../cart/cart.service.js';
import type { QuickShopService } from '../cart/quick-shop.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerShopService } from './customer-shop.service.js';
import { customerShow } from './customer-send.js';
import { shoppingAction, adjustData, type ShoppingAction } from './shopping-callback.js';
import { cartQuantityValid } from '../order/cart-quote.js';
import { requestedLine } from '../order/pricing.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fallbackHtml, richMessage, validScreen } from './rich.js';

vi.mock('./customer-send.js', () => ({ customerShow: vi.fn(async () => true), customerPrompt: vi.fn() }));
const target = { chatId: 70001, messageId: 90 }, identity = { id: 3, userId: 7 };
const dill = { id: 11, name: 'Укроп', slug: 'dill', description: 'Свежая зелень <script>не HTML</script>',
  unit: 'BUNCH' as const, priceUnit: 'BUNCH' as const, saleModel: 'BUNCH' as const,
  price: 16500, priceQty: 1, priceStatus: 'SOURCE' as const, serviceMarkupPercent: 0,
  min: 1, step: 1, portionQty: 1, estimatedWeightGrams: null as number | null,
  marketPoint: null, categoryId: 2, images: [{ url: '/uploads/products/fixture.webp', alt: 'Укроп' }] };
type Source = Omit<typeof dill, 'unit' | 'priceUnit' | 'saleModel' | 'priceStatus'> & {
  priceStatus: 'SOURCE' | 'ESTIMATED';
  unit: 'BUNCH' | 'GRAM' | 'PIECE' | 'PACK'; priceUnit: 'BUNCH' | 'GRAM' | 'PIECE' | 'PACK'; saleModel: 'BUNCH' | 'WEIGHT_LOOSE' | 'WHOLE_VARIABLE_WEIGHT' | 'PIECE_FIXED' | 'PACK';
};
function setup(product: Source = dill, initial = 0, categoryCount = 27) {
  let revision = randomUUID(), qty = initial, lost = false;
  const snapshot = () => ({ revision, items: qty ? [{ productId: product.id, qty, quantityUnit: product.unit,
    status: 'AVAILABLE' as const, product: { ...product }, lineTotal: requestedLine({ ...product, qty }) }] : [],
    goodsTotal: qty ? requestedLine({ ...product, qty }) : 0, subtotal: qty ? requestedLine({ ...product, qty }) : 0, valid: true, promo: null });
  const db = { product: { findFirst: vi.fn(async () => product), count: vi.fn(async () => 37),
    findMany: vi.fn(async ({ skip = 0, take = 8 }: { skip?: number; take?: number }) => Array.from({ length: Math.min(take, 37 - skip) }, (_, i) => ({ ...product, id: skip + i + 1 }))) },
    category: { count: vi.fn(async () => categoryCount), findFirst: vi.fn(async () => ({ name: 'Зелень' })),
      findMany: vi.fn(async ({ skip = 0, take = categoryCount }: { skip?: number; take?: number }) => Array.from({ length: Math.min(take, categoryCount - skip) }, (_, i) => ({ id: skip + i + 1, name: 'Категория ' + (skip + i + 1) }))) },
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

const categoryAdjustment = (delta: number) => {
  const action = actions().find((action): action is Extract<ShoppingAction, { kind: 'adjust' }> =>
    action?.kind === 'adjust' && action.productId === 11 && action.delta === delta && action.inCategory === true);
  if (!action) throw new Error('Category adjustment missing');
  return action;
};
it.each([
  { ...dill, min: 3, step: 1 },
  { ...dill, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', priceQty: 1000, min: 500, step: 100 },
  { ...dill, unit: 'PIECE', priceUnit: 'PIECE', saleModel: 'PIECE_FIXED', min: 1, step: 1 },
  { ...dill, unit: 'PACK', priceUnit: 'PACK', saleModel: 'PACK', min: 2, step: 1 },
  { ...dill, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000, min: 1, step: 1 },
] satisfies Source[])('adds $saleModel from a category at min, then adjusts by step and rejects stale callbacks on the same page', async product => {
  const s = setup(product);
  await s.service.handle(target, identity, { kind: 'products', categoryId: 2, page: 1 });
  const first = categoryAdjustment(product.min);
  const photos = screen().rich!.blocks.filter(block => block.type === 'collage');
  await s.service.handle(target, identity, first);
  expect(s.snapshot().items[0]?.qty).toBe(product.min);
  expect(screen().text).toMatch(/^Зелень/); expect(screen().text).toContain('Страница 2 из 5');
  expect(screen().keyboard.inline_keyboard.flat().find(button => {
    const action = 'callback_data' in button ? shoppingAction(button.callback_data) : null;
    return action?.kind === 'open' && action.productId === 11;
  })?.text).toContain('🛒');
  expect(screen().rich!.blocks.filter(block => block.type === 'collage')).toEqual(photos);
  expect(s.db.product.findFirst).not.toHaveBeenCalled();
  await expect(s.service.handle(target, identity, first)).rejects.toBeInstanceOf(ConflictException);
  expect(s.cart.change).toHaveBeenCalledTimes(1); expect(screen().text).toContain('Старое действие не применено');
  expect(screen().text).not.toContain('✅ Добавлен');
  await s.service.handle(target, identity, categoryAdjustment(product.step));
  expect(s.snapshot().items[0]?.qty).toBe(product.min + product.step);
  await s.service.handle(target, identity, categoryAdjustment(-product.step));
  expect(s.snapshot().items[0]?.qty).toBe(product.min);
  if (product.min > product.step) expect(actions().some(action => action?.kind === 'adjust' && action.productId === 11 && action.delta < 0)).toBe(false);
  else {
    await s.service.handle(target, identity, categoryAdjustment(-product.step));
    expect(s.snapshot().items).toHaveLength(0); expect(screen().text).toContain('Удалён:');
  }
  expect(validScreen(screen())).toBe(true);
});
it('rereads a category after an unknown committed mutation without replaying it or confirming success', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'products', categoryId: 2, page: 1 });
  s.loseNextResponse();
  await expect(s.service.handle(target, identity, categoryAdjustment(1))).rejects.toThrow('Lost response');
  expect(s.cart.change).toHaveBeenCalledTimes(1); expect(s.snapshot().items[0]?.qty).toBe(1);
  expect(screen().text).toMatch(/^Зелень/); expect(screen().text).toContain('Изменение не подтверждено');
  expect(screen().text).not.toContain('✅ Добавлен');
});
it('keeps largest direct-category callbacks inside 64 bytes and rejects a missing/foreign category context', () => {
  const context = { origin: 'category' as const, categoryId: 2147483647, page: 10000 };
  const data = adjustData('11111111-1111-4111-8111-111111111111', 2147483647, 1000000, 'PIECE', context, true);
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  expect(shoppingAction(data)).toEqual({ ...context, kind: 'adjust', productId: 2147483647, delta: 1000000,
    quantityUnit: 'PIECE', revision: '11111111-1111-4111-8111-111111111111', inCategory: true });
  for (const origin of ['basket', 'quick', 'category'] as const)
    expect(shoppingAction(adjustData('11111111-1111-4111-8111-111111111111', 11, 1, 'PIECE', { origin, page: 0 }, true))).toBeNull();
});

it('repeats single steps and keeps the acknowledged quantity across basket and product navigation', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 2, origin: 'category' });
  for (const [delta, qty] of [[1,1], [1,2], [1,3], [-1,2], [1,3], [1,4]] as const) {
    const action = adjustment(delta);
    await s.service.handle(target, identity, action);
    expect(s.snapshot().items[0]?.qty).toBe(qty);
    expect(screen().text).toContain('В корзине этого товара: ' + qty + (qty === 1 ? ' пучок' : ' пучка'));
    expect(adjustment(1).revision).toBe(s.snapshot().revision);
    expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:2:2' });
  }
  expect(screen().text).toContain('✅ +1 пучок · +165 ₽');
  await s.service.basket(target, identity);
  expect(screen().text).toContain('В корзине: 4 пучка\nЗа товар: ≈ 660 ₽');
  const open = actions().find(action => action?.kind === 'open'); if (!open) throw new Error('Open action missing');
  await s.service.handle(target, identity, open);
  expect(screen().text).toContain('В корзине этого товара: 4 пучка');
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К корзине', callback_data: 's:k:0' });
  expect(s.cart.change).toHaveBeenCalledTimes(6);
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
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('🛒 Добавить в корзину · 1 пучок · ≈ 165 ₽');
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ Добавлен: Укроп\n+1 пучок · +≈ 165 ₽');
});
it('does not reapply an old button after success and refreshes it without a false success receipt', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  const old = adjustment(1);
  await s.service.handle(target, identity, old);
  await expect(s.service.handle(target, identity, old)).rejects.toBeInstanceOf(ConflictException);
  expect(s.snapshot().items[0]?.qty).toBe(1); expect(s.cart.change).toHaveBeenCalledTimes(1);
  expect(screen().text).toContain('Старое действие не применено'); expect(screen().text).not.toContain('✅ Добавлено');
});
it('reads after a lost write response, with no blind replay or invented receipt', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  s.loseNextResponse(); await expect(s.service.handle(target, identity, adjustment(1))).rejects.toThrow('Lost response');
  expect(s.cart.change).toHaveBeenCalledTimes(1); expect(s.snapshot().items[0]?.qty).toBe(1);
  expect(screen().text).toContain('Корзина перечитана'); expect(screen().text).not.toContain('✅ Добавлено');
  expect(adjustment(1).revision).toBe(s.snapshot().revision);
});
it('uses configured weight steps and server line rounding for immediate action estimates', async () => {
  const s = setup({ ...dill, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', min: 500, step: 500, priceQty: 1000, price: 29000 });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('🛒 Добавить в корзину · 500 г · ≈ 145 ₽');
  expect(actions().filter(action => action?.kind === 'adjust')).toHaveLength(1);
  await s.service.handle(target, identity, adjustment(500)); expect(s.snapshot().items[0]?.qty).toBe(500);
});
it('keeps whole goods in pieces and includes media on ordinary opening and edits', async () => {
  const s = setup({ ...dill, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000, price: 77000 });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 1, origin: 'category' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('🛒 Добавить в корзину · 1 шт. · После взвешивания');
  expect(screen().rich?.blocks.some(block => block.type === 'photo')).toBe(true);
  expect(adjustment(1).quantityUnit).toBe('PIECE');
  await s.service.handle(target, identity, { kind: 'details', productId: 11, page: 1, origin: 'category' });
  expect(screen().rich?.blocks.some(block => block.type === 'photo')).toBe(true);
  expect(screen().rich?.blocks.some(block => block.type === 'details')).toBe(true);
  expect(s.cart.change).not.toHaveBeenCalled();
});
it('counts available categories on the server, clamps pages and lays them out in two columns', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'categories', page: 9999 });
  expect(screen().text).not.toContain('Страница');
  expect(screen().keyboard.inline_keyboard[0]).toHaveLength(2);
  expect(s.db.category.count).toHaveBeenCalledWith({ where: { active: true, products: { some: { active: true } } } });
  expect(s.db.category.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 48 }));
});
it('shows product ranges/counts and retains the originating category page', async () => {
  const s = setup(); await s.service.handle(target, identity, { kind: 'products', categoryId: 2, page: 1 });
  expect(screen().text).toContain('Страница 2 из 5'); expect(screen().text).toContain('Товары 9–16 из 37');
  const open = actions().find(action => action?.kind === 'open' && action.productId === 11); if (!open) throw new Error('Product missing');
  await s.service.handle(target, identity, open);
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:2:1' });
});
it('retains the original category through product moves, quantity edits and details', async () => {
  const source = { ...dill }, s = setup(source);
  await s.service.handle(target, identity, { kind: 'products', categoryId: 2, page: 1 });
  const open = actions().find(action => action?.kind === 'open' && action.productId === 11);
  if (!open) throw new Error('Product missing');
  expect(open).toMatchObject({ categoryId: 2, page: 1 });
  source.categoryId = 9;
  await s.service.handle(target, identity, open);
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:2:1' });
  expect(adjustment(1)).toMatchObject({ categoryId: 2, page: 1 });
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:2:1' });
  const details = actions().find(action => action?.kind === 'details');
  if (!details) throw new Error('Details missing');
  expect(details).toMatchObject({ categoryId: 2, page: 1 });
  await s.service.handle(target, identity, details);
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

it.each([1, 8, 16, 48, 49, 2000])('fits %i categories or automatically paginates without empty pages', async total => {
  const s = setup(dill, 0, total);
  await s.service.handle(target, identity, { kind: 'categories', page: 9999 });
  const categoryButtons = actions().filter(action => action?.kind === 'products');
  expect(categoryButtons.length).toBeGreaterThan(0);
  expect(categoryButtons.length).toBeLessThanOrEqual(total <= 48 ? 48 : 24);
  expect(screen().text.includes('Страница')).toBe(total > 48);
  expect(validScreen(screen())).toBe(true);
  if (total <= 48) expect(categoryButtons).toHaveLength(total);
  for (const row of screen().keyboard.inline_keyboard) expect(row.length).toBeLessThanOrEqual(2);
});

it.each(['GRAM', 'PIECE', 'BUNCH', 'PACK'] as const)('renders a compact four-button basket row and exact +/- step for %s', async unit => {
  const step = unit === 'GRAM' ? 500 : 1;
  const source: Source = { ...dill, name: 'Очень длинное полное название товара без сокращений в корзине',
    unit, priceUnit: unit, saleModel: unit === 'GRAM' ? 'WEIGHT_LOOSE' : unit === 'PIECE' ? 'PIECE_FIXED' : unit,
    min: step, step, priceQty: step };
  const s = setup(source, step);
  await s.service.basket(target, identity);
  const row = screen().keyboard.inline_keyboard.find(row => row.some(button => button.text === '✕'))!;
  expect(row.map(button => button.text)).toEqual([expect.stringContaining('…'), '−', '+', '✕']);
  expect(row.map(button => button.style)).toEqual(['primary', undefined, 'success', 'danger']);
  expect(row[0]!.text.length).toBeLessThanOrEqual(16);
  expect(screen().text).toContain(source.name);
  const embedded = richMessage(screen()).blocks.filter(block => block.type === 'buttons' && block.buttons.length === 4);
  expect(embedded).toHaveLength(1);
  expect(adjustment(-step)).toMatchObject({ delta: -step, origin: 'basket', page: 0, revision: s.snapshot().revision });
  await s.service.handle(target, identity, adjustment(step));
  expect(s.snapshot().items[0]?.qty).toBe(2 * step);
  await s.service.handle(target, identity, adjustment(-step));
  expect(s.snapshot().items[0]?.qty).toBe(step);
  await s.service.handle(target, identity, adjustment(-step));
  expect(s.snapshot().items).toHaveLength(0);
  expect(validScreen(screen())).toBe(true);
});

it('disables a decrease that would cross min instead of silently removing more than one step', async () => {
  const s = setup({ ...dill, min: 3, step: 1 }, 3);
  await s.service.basket(target, identity);
  expect(screen().keyboard.inline_keyboard.find(row => row.some(button => button.text === '✕'))![1]).toEqual({ text: '−', disabled: {} });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  expect(actions().some(action => action?.kind === 'adjust' && action.delta < 0)).toBe(false);
});
it('starts above-step minimum goods at the actual minimum, then offers only one configured step', async () => {
  const s = setup({ ...dill, min: 3, step: 1 });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('🛒 Добавить в корзину · 3 пучка · 495 ₽');
  await s.service.handle(target, identity, adjustment(3));
  expect(s.snapshot().items[0]?.qty).toBe(3);
  expect(screen().text).toContain('✅ Добавлен: Укроп\n+3 пучка · +495 ₽');
  expect(actions().filter(action => action?.kind === 'adjust' && action.delta > 0)).toEqual([expect.objectContaining({ delta: 1 })]);
});

it('separates basket total, signed change and current line while keeping one product position', async () => {
  const s = setup({ ...dill, name: 'Фисташки', unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE',
    min: 500, step: 100, priceQty: 1000, price: 198000 }, 1000);
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(100));
  expect(screen().text).toContain('1 товар');
  expect(screen().text).toMatch(/ИТОГО ПРЕДВАРИТЕЛЬНО\n≈ 2\u00a0178 ₽$/);
  expect(screen().text).toContain('✅ +100 г · +≈ 198 ₽');
  expect(screen().text).toContain('⚖️ В корзине: 1,1 кг\nЗа товар: ≈ 2\u00a0178 ₽\nШаг покупки: 100 г');
  expect(screen().text).not.toContain('Товары предварительно:');
  expect(screen().text.match(/198 ₽/g)).toHaveLength(1);
  expect(s.snapshot().items).toHaveLength(1);
  const rich = richMessage(screen());
  expect(rich.blocks.some(block => block.type === 'divider')).toBe(true);
  expect(JSON.stringify(rich)).toContain(JSON.stringify({ type: 'bold', text: '1,1 кг' }));
  expect(JSON.stringify(rich)).toContain(JSON.stringify({ type: 'bold', text: '≈ 2\u00a0178 ₽' }));
  expect(rich.blocks.filter(block => block.type === 'paragraph' && JSON.stringify(block.text).includes('Фисташки'))).toHaveLength(0);
  const html = fallbackHtml(screen().text, screen().fallback);
  expect(html).toContain('⚖️ В корзине: <b>1,1 кг</b>');
  expect(html).toContain('За товар: <b>≈ 2\u00a0178 ₽</b>');
  await s.service.handle(target, identity, adjustment(-100));
  expect(screen().text).toContain('➖ −100 г · −≈ 198 ₽');
  expect(screen().text).toMatch(/ИТОГО ПРЕДВАРИТЕЛЬНО\n≈ 1\u00a0980 ₽$/);
  expect(screen().text).not.toContain('✅ +100 г');
  expect(screen().text).toContain('⚖️ В корзине: 1 кг');
  await s.service.basket(target, identity);
  expect(screen().text).not.toContain('➖');
  expect(screen().text).not.toContain('✅');
});

it('forgets a receipt on another screen and never persists it in the basket state', async () => {
  const s = setup(dill, 1);
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ +1 пучок');
  const open = actions().find(action => action?.kind === 'open');
  if (!open) throw new Error('Open action missing');
  await s.service.handle(target, identity, open);
  expect(screen().text).not.toContain('✅');
  await s.service.handle(target, identity, { kind: 'basket', page: 0 });
  expect(screen().text).not.toContain('✅');
});

it('reports complete deletion once, including the last decrement', async () => {
  const s = setup(dill, 1);
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(-1));
  expect(screen().text).toContain('0 товаров');
  expect(screen().text.match(/Удалён: Укроп/g)).toHaveLength(1);
  expect(screen().text).not.toContain('−1 пучок');
  expect(screen().text).not.toContain('За товар:');
  expect(s.cart.change).toHaveBeenCalledTimes(1);
});

it('reports the protected remove action with a single deletion receipt', async () => {
  const s = setup(dill, 6);
  await s.service.basket(target, identity);
  const remove = actions().find(action => action?.kind === 'remove');
  if (!remove) throw new Error('Remove action missing');
  await s.service.handle(target, identity, remove);
  expect(screen().text).toContain('🗑 Удалён: Укроп');
  expect(screen().text).not.toContain('6 пучков');
  expect(s.cart.change).toHaveBeenCalledTimes(1);
});

it('derives the money delta from rounded server totals rather than the price of a separate step', async () => {
  const s = setup({ ...dill, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE',
    min: 1, step: 1, priceQty: 1000, price: 1499 }, 1);
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ +1 г · +≈ 0,02 ₽');
  expect(screen().text).toContain('За товар: ≈ 0,03 ₽');
});

it('uses confirmed quantities in a new-line receipt instead of echoing the requested delta', async () => {
  const s = setup();
  s.cart.change.mockResolvedValueOnce({ ...s.snapshot(), revision: randomUUID(), items: [{ productId: dill.id, qty: 3,
    quantityUnit: 'BUNCH', status: 'AVAILABLE', product: dill, lineTotal: 49500 }], goodsTotal: 49500, subtotal: 49500 });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ Добавлен: Укроп\n+3 пучка · +495 ₽');
  expect(screen().text).not.toContain('✅ +1 пучок');
});

it('does not invent a money delta when the price changes during a mutation', async () => {
  const source = { ...dill };
  const s = setup(source, 1), change = s.cart.change.getMockImplementation()!;
  s.cart.change.mockImplementationOnce(async (...args) => { source.price = 20000; return change(...args); });
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ Количество обновлено\nСтоимость пересчитана');
  expect(screen().text).not.toContain('+235 ₽');
  expect(screen().text).not.toContain('+165 ₽');
  expect(screen().text).toContain('За товар: ≈ 400 ₽');
});

it('does not use an invalid line as the basis of a monetary receipt', async () => {
  const s = setup(dill, 1);
  const after = { ...s.snapshot(), revision: randomUUID(), items: [{ ...s.snapshot().items[0]!, qty: 2,
    status: 'INVALID_QUANTITY', lineTotal: 33000 }], goodsTotal: 33000, subtotal: 33000 };
  s.cart.change.mockResolvedValueOnce(after as unknown as ReturnType<typeof s.snapshot>);
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ Количество обновлено\nСтоимость пересчитана');
  expect(screen().text).not.toContain('+165 ₽');
});

it('keeps unknown weighted prices unknown after a successful quantity update', async () => {
  const s = setup({ ...dill, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000 }, 1);
  await s.service.basket(target, identity);
  await s.service.handle(target, identity, adjustment(1));
  expect(screen().text).toContain('✅ Количество обновлено\nСтоимость пересчитана');
  expect(screen().text).toContain('В корзине: 2 шт.\nЗа товар: после взвешивания');
  expect(screen().text).not.toContain('0 ₽');
  expect(screen().text).not.toContain('Фактический');
});

it('counts distinct products without counting their quantity as positions', async () => {
  const s = setup(dill, 6), before = s.snapshot();
  const items = [before.items[0]!, { ...before.items[0]!, productId: 12, quantityUnit: 'PIECE' as const,
    product: { ...dill, id: 12, name: 'Киви', unit: 'PIECE' as const, priceUnit: 'PIECE' as const, saleModel: 'PIECE_FIXED' as const }, qty: 2 }];
  s.cart.get.mockResolvedValueOnce({ ...before, items });
  await s.service.basket(target, identity);
  expect(screen().text).toContain('2 товара');
  expect(screen().text).not.toContain('8 товаров');
  expect(screen().text).toContain('В корзине: 6 пучков');
  expect(screen().text).toContain('В корзине: 2 шт.');
});

it('does not replay a confirmed cart write if Telegram presentation fails', async () => {
  const s = setup(dill, 1);
  await s.service.basket(target, identity);
  const action = adjustment(1);
  vi.mocked(customerShow).mockRejectedValueOnce(new Error('Telegram edit timeout'));
  await expect(s.service.handle(target, identity, action)).rejects.toThrow('Telegram edit timeout');
  expect(s.snapshot().items[0]?.qty).toBe(2);
  expect(s.cart.change).toHaveBeenCalledTimes(1);
});

it('clamps a deleted final basket page and keeps surviving item callbacks on the new page', async () => {
  const s = setup(dill, 1), item = s.snapshot().items[0]!;
  const before = { ...s.snapshot(), items: Array.from({ length: 6 }, (_, i) => ({ ...item, productId: i + 1 })) };
  s.cart.get.mockResolvedValue(before);
  s.cart.change.mockResolvedValue({ ...before, items: before.items.slice(0, 5) });
  await s.service.basket(target, identity, 1);
  const remove = actions().find(action => action?.kind === 'remove'); if (!remove) throw new Error('Remove missing');
  expect(remove).toMatchObject({ productId: 6, page: 1 });
  await s.service.handle(target, identity, remove);
  expect(screen().text).not.toContain('Страница 1 из 1');
  expect(actions().filter(action => action?.kind === 'adjust').every(action => action.page === 0)).toBe(true);
  expect(s.cart.change).toHaveBeenCalledWith(7, before.revision, expect.objectContaining({ kind: 'remove', productId: 6 }));
});
it('keeps overflow/unavailable basket lines removable without evaluating an unsafe action price', async () => {
  const s = setup();
  const snapshot = { ...s.snapshot(), items: [{ productId: 11, qty: 1000, quantityUnit: 'GRAM' as const,
    product: { ...dill, unit: 'GRAM' as const, priceUnit: 'GRAM' as const, saleModel: 'WEIGHT_LOOSE' as const, price: 2147483647, priceQty: 1, step: 1000 },
    status: 'PRICE_OVERFLOW', lineTotal: null }], goodsTotal: null, subtotal: null, valid: false };
  s.cart.get.mockResolvedValue(snapshot as unknown as ReturnType<typeof s.snapshot>);
  await s.service.basket(target, identity);
  expect(screen().keyboard.inline_keyboard[0]!.map(button => button.text)).toEqual(['Укроп', '−', '+', '✕']);
  expect(screen().keyboard.inline_keyboard[0]![1]).toHaveProperty('disabled');
  expect(screen().keyboard.inline_keyboard[0]![2]).toHaveProperty('disabled');
  expect(validScreen(screen())).toBe(true);
});

it('fences two concurrent presses of the same rendered revision', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  const action = adjustment(1);
  const results = await Promise.allSettled([s.service.handle(target, identity, action), s.service.handle(target, identity, action)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(s.snapshot().items[0]?.qty).toBe(1);
});

it.each(['missing', 'invalid', 'valid'] as const)('reports %s image availability safely', async mode => {
  const s = setup({ ...dill, images: mode === 'missing' ? [] : [{ url: mode === 'invalid' ? 'https://private.example/photo?token=secret' : dill.images[0]!.url, alt: '' }] });
  await s.service.handle(target, identity, { kind: 'open', productId: 11, page: 0, origin: 'category' });
  expect(screen().mediaReason).toBe(mode === 'missing' ? 'no_image' : mode === 'invalid' ? 'invalid_url' : undefined);
  expect(screen().rich?.blocks.some(block => block.type === 'photo')).toBe(mode === 'valid');
});
