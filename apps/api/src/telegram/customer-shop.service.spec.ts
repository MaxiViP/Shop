import type { QuickShopService } from '../cart/quick-shop.service.js';
import { ConflictException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { CartService } from '../cart/cart.service.js';
import type { OrderService } from '../order/order.service.js';
import { CustomerShopService } from './customer-shop.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { customerShow } from './customer-send.js';
import { shoppingAction } from './shopping-callback.js';

vi.mock('./customer-send.js', () => ({ customerShow: vi.fn().mockResolvedValue(true), customerPrompt: vi.fn() }));
const revision = '11111111-1111-4111-8111-111111111111';
const freshRevision = '22222222-2222-4222-8222-222222222222';
const target = { chatId: 17, messageId: 90 };
const identity = { userId: 7, id: 3 };
const product = { id: 11, name: 'Помидоры розовые', slug: 'pink-tomatoes', price: 32000,
  serviceMarkupPercent: 0, priceQty: 1000, unit: 'GRAM', priceUnit: 'GRAM',
  saleModel: 'WEIGHT_LOOSE', min: 250, step: 250, portionQty: 500, estimatedWeightGrams: null as number | null,
  marketPoint: null, categoryId: 2, active: true, images: [] };
type Basket = Awaited<ReturnType<CartService['get']>>;
function setup(source = product, qty = 500, lineTotal: number | null = 16000) {
  const basket = { revision, items: [{ productId: source.id, qty, product: source,
    status: 'AVAILABLE', lineTotal }], goodsTotal: lineTotal, subtotal: lineTotal, valid: true } as unknown as Basket;
  const db = { product: { findFirst: vi.fn().mockResolvedValue(source) } };
  const cart = { get: vi.fn().mockResolvedValue(basket), change: vi.fn().mockResolvedValue({ ...basket, revision: freshRevision }) };
  const service = new CustomerShopService(db as unknown as DbService, cart as unknown as CartService,
    {} as CustomerCheckoutService, {} as OrderService, {} as QuickShopService);
  return { service, db, cart, basket };
}
const screen = () => vi.mocked(customerShow).mock.calls.at(-1)![1];
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(() => vi.unstubAllEnvs());

it('keeps a stale cart quantity in its stored unit and offers removal instead of invalid steps', async () => {
  const s = setup({ ...product, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1, portionQty: 1 });
  const item = s.basket.items[0]!;
  item.quantityUnit = 'GRAM';
  item.status = 'INVALID_QUANTITY';
  await s.service.basket(target, identity);
  expect(screen().text).toContain('500 г');
  expect(screen().text).not.toContain('500 шт.');
  const buttons = screen().keyboard.inline_keyboard.flat();
  expect(buttons.some(button => button.text === '✕')).toBe(true);
  expect(buttons.some(button => button.text === '+1 шт.')).toBe(false);
});

it('shows acknowledged cart quantity and immediate priced step controls without a quantity draft', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'product', productId: 11, qty: 250 });
  expect(screen().text).toContain('Цена: 320 ₽ / 1 кг');
  expect(screen().text).not.toContain('Добавить ещё');
  expect(screen().text).toContain('В корзине этого товара: 500 г · ≈ 160 ₽');
  expect(screen().text).toContain('Вся корзина: 1 поз. · ≈ 160 ₽');
  const buttons = screen().keyboard.inline_keyboard.flat();
  expect(buttons.map(button => button.text)).toContain('+250 г · ≈ 80 ₽');
  expect(buttons.map(button => button.text)).not.toContain('+500 г · ≈ 160 ₽');
  expect(buttons.every(button => !button.text.startsWith('➕ Добавить'))).toBe(true);
});

it('keeps the product open after adding and uses the returned cart revision and quoted total', async () => {
  const s = setup();
  s.cart.change.mockResolvedValueOnce({ ...s.basket, revision: freshRevision, goodsTotal: 24000,
    items: [{ ...s.basket.items[0]!, qty: 750, lineTotal: 24000 }] });
  await s.service.handle(target, identity, { kind: 'add', productId: 11, qty: 250, revision, quantityUnit: 'GRAM' });
  expect(s.cart.change).toHaveBeenCalledWith(7, revision,
    { kind: 'add', productId: 11, qty: 250, revision, quantityUnit: 'GRAM' });
  expect(s.cart.get).toHaveBeenCalledWith(7);
  expect(screen().text).toContain('✅ +250 г · +≈ 80 ₽');
  expect(screen().text).toContain('В корзине этого товара: 750 г · ≈ 240 ₽');
  const adds = screen().keyboard.inline_keyboard.flat().flatMap(button => {
    if (!('callback_data' in button)) return [];
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    const action = shoppingAction(button.callback_data);
    return action?.kind === 'adjust' ? [action] : [];
  });
  expect(adds.length).toBeGreaterThan(0);
  expect(adds.every(action => action.revision === freshRevision && action.quantityUnit === 'GRAM')).toBe(true);
});

it('shows whole weighted goods as pieces with a per-kilogram price and no invented total', async () => {
  const whole = { ...product, name: 'Рыба', unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT',
    price: 65000, min: 1, step: 1, portionQty: 1 };
  const s = setup(whole, 1, null);
  await s.service.handle(target, identity, { kind: 'product', productId: 11, qty: 1 });
  expect(screen().text).toContain('Цена: 650 ₽ / 1 кг');
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text)).toContain('+1 шт. · После взвешивания');
  expect(screen().text).toContain('В корзине этого товара: 1 шт. · после взвешивания');
  expect(screen().text).not.toContain('1 000 шт.');
  expect(screen().text).not.toContain('≈ 0');
  const adds = screen().keyboard.inline_keyboard.flat().flatMap(button =>
    'callback_data' in button ? [shoppingAction(button.callback_data)] : []);
  expect(adds).toContainEqual({ kind: 'adjust', productId: 11, delta: 1, revision, quantityUnit: 'PIECE', page: 0, origin: 'category' });
});

it('uses estimated grams for a whole item when a confirmed estimate exists', async () => {
  const s = setup({ ...product, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT',
    min: 1, step: 1, portionQty: 1, estimatedWeightGrams: 1500 }, 1, 48000);
  await s.service.handle(target, identity, { kind: 'product', productId: 11, qty: 1 });
  expect(screen().text).toContain('Ожидаемый вес экземпляра: 1,5 кг · ≈ 480 ₽');
});

it('does not reapply a stale add or display an uncommitted success', async () => {
  const s = setup();
  s.cart.change.mockRejectedValueOnce(new ConflictException('Корзина уже изменилась'));
  await expect(s.service.handle(target, identity, { kind: 'add', productId: 11, qty: 250, revision }))
    .rejects.toBeInstanceOf(ConflictException);
  expect(s.cart.change).toHaveBeenCalledTimes(1);
  expect(customerShow).not.toHaveBeenCalled();
});

it('labels cart mutations with their weight step and preserves the explicit remove action', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'cart' });
  expect(screen().keyboard.inline_keyboard.flat().map(button => button.text))
    .toEqual(expect.arrayContaining(['−', '+', '✕']));
  expect(screen().text).toContain('Шаг покупки: 250 г');
  expect(screen().text).not.toContain('≈ 80 ₽');
});

it('uses the authoritative cart value in the main menu, including unknown weighted totals', async () => {
  const s = setup();
  expect(await s.service.cartLabel(identity)).toBe('🛒 Корзина · 1 поз. · ≈ 160 ₽');
  s.cart.get.mockResolvedValueOnce({ ...s.basket, goodsTotal: null });
  expect(await s.service.cartLabel(identity)).toBe('🛒 Корзина · 1 поз. · после взвешивания');
});

it('preserves the original quantity unit when sale terms changed and blocks more additions', async () => {
  const s = setup({ ...product, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT',
    min: 1, step: 1, portionQty: 1 }, 1000, null);
  s.cart.get.mockResolvedValueOnce({ ...s.basket, items: [{ ...s.basket.items[0]!,
    quantityUnit: 'GRAM', status: 'INVALID_QUANTITY' }] });
  await s.service.handle(target, identity, { kind: 'product', productId: 11, qty: 1 });
  expect(screen().text).toContain('В корзине этого товара: 1 кг');
  expect(screen().text).toContain('Условия товара изменились');
  const actions = screen().keyboard.inline_keyboard.flat().flatMap(button =>
    'callback_data' in button ? [shoppingAction(button.callback_data)] : []);
  expect(actions.some(action => action?.kind === 'add')).toBe(false);
});


it('opening clear asks for confirmation and does not mutate the cart', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'clear', revision });
  expect(s.cart.change).not.toHaveBeenCalled();
  expect(screen().text).toContain('Очистить корзину?');
  const actions = screen().keyboard.inline_keyboard.flat().flatMap(button =>
    'callback_data' in button ? [shoppingAction(button.callback_data)] : []);
  expect(actions).toContainEqual({ kind: 'clearConfirmed', revision });
});

it('never offers stale clear confirmation for a newer cart', async () => {
  const s = setup();
  s.cart.get.mockResolvedValueOnce({ ...s.basket, revision: freshRevision });
  await expect(s.service.handle(target, identity, { kind: 'clear', revision })).rejects.toBeInstanceOf(ConflictException);
  expect(s.cart.change).not.toHaveBeenCalled();
  expect(customerShow).not.toHaveBeenCalled();
});

it('confirmed clear uses the original authoritative revision and only then returns to the cart', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'clearConfirmed', revision });
  expect(s.cart.change).toHaveBeenCalledOnce();
  expect(s.cart.change).toHaveBeenCalledWith(7, revision, { kind: 'clear' });
  expect(screen().text).toContain('Ваша корзина');
});

it('a rejected confirmed clear is never retried or shown as successful', async () => {
  const s = setup();
  s.cart.change.mockRejectedValueOnce(new ConflictException());
  await expect(s.service.handle(target, identity, { kind: 'clearConfirmed', revision })).rejects.toBeInstanceOf(ConflictException);
  expect(s.cart.change).toHaveBeenCalledOnce();
  expect(customerShow).not.toHaveBeenCalled();
});

it('public product preview reads no basket and offers no mutation callbacks', async () => {
  const s = setup();
  await s.service.handle(target, identity, { kind: 'product', productId: product.id, qty: 250 }, true);
  expect(s.cart.get).not.toHaveBeenCalled();
  expect(s.cart.change).not.toHaveBeenCalled();
  expect(screen().text).toContain('320 ₽ / 1 кг');
  expect(screen().text).toContain('подтвердите свой номер');
  const actions = screen().keyboard.inline_keyboard.flat().flatMap(button =>
    'callback_data' in button ? [shoppingAction(button.callback_data)] : []);
  expect(actions.some(action => action?.kind === 'add')).toBe(false);
});

it.each(['add', 'checkout', 'clearConfirmed', 'cart'] as const)('browse-only mode rejects %s before accessing private services', async kind => {
  const s = setup();
  const action = kind === 'add' ? { kind, productId: 11, qty: 250, revision } :
    kind === 'cart' ? { kind } : { kind, revision };
  await expect(s.service.handle(target, identity, action, true)).rejects.toThrow('подтвердите свой номер');
  expect(s.cart.get).not.toHaveBeenCalled();
  expect(s.cart.change).not.toHaveBeenCalled();
});
