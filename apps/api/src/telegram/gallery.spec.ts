import type { DbService } from '../db/db.service.js';
import type { CartService } from '../cart/cart.service.js';
import type { QuickShopService } from '../cart/quick-shop.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerShopService } from './customer-shop.service.js';
import { customerShow } from './customer-send.js';
import { shoppingAction } from './shopping-callback.js';
import { customerScreen, richMessage, validScreen } from './rich.js';
import * as catalog from './catalog-photo.js';
import { deliverScreen } from './delivery.js';
vi.mock('./customer-send.js', () => ({ customerShow: vi.fn(async () => true) }));
const target = { chatId: 123 }, identity = { id: 1, userId: 2 };
const product = (id: number) => ({ id, name: 'Товар ' + id, slug: 'item-' + id, unit: 'PIECE' as const,
  priceUnit: 'PIECE' as const, saleModel: 'PIECE_FIXED' as const, price: 11000, priceQty: 1,
  priceStatus: 'SOURCE' as const, serviceMarkupPercent: 0, min: 1, step: 1, portionQty: 1,
  estimatedWeightGrams: null, marketPoint: null, categoryId: 3, images: [{ url: '/uploads/products/item-' + id + '.webp', alt: '' }] });
function setup(total: number) {
  const db = { category: { findFirst: vi.fn(async () => ({ name: 'Консервы и соленья' })), findMany: vi.fn(async () => [{ id: 3 }]) },
    product: { count: vi.fn(async () => total), findMany: vi.fn(async ({ skip, take }: { skip: number; take: number }) =>
      Array.from({ length: Math.max(0, Math.min(take, total - skip)) }, (_, index) => product(skip + index + 100))),
      findFirst: vi.fn(async ({ where }: { where: { id: number } }) => product(where.id)) }, $transaction: vi.fn() };
  db.$transaction.mockImplementation(async (run: (db: unknown) => Promise<unknown>) => run(db));
  const cart = { get: vi.fn(async () => ({ revision: '11111111-1111-4111-8111-111111111111', items: [], goodsTotal: 0 }) as Awaited<ReturnType<CartService['get']>>) };
  return { db, cart, service: new CustomerShopService(db as unknown as DbService, cart as unknown as CartService, {} as CustomerCheckoutService, {} as OrderService, {} as QuickShopService) };
}
const screen = () => vi.mocked(customerShow).mock.calls.at(-1)![1];
const blocks = () => richMessage(customerScreen(screen())).blocks;
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(catalog, 'catalogPair'); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each([0, 1, 2, 3, 7, 8, 17])('renders %s products in atomic two-panel photos with short real action rows', async total => {
  const { service } = setup(total); await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const rendered = blocks(), photos = rendered.filter(block => block.type === 'photo');
  expect(photos).toHaveLength(Math.ceil(Math.min(total, 8) / 2)); expect(rendered.some(block => block.type === 'collage' || block.type === 'table')).toBe(false);
  expect(rendered[0]?.type).toBe('paragraph'); expect(screen().text.split('\n')[0]).not.toMatch(/Страница|Товары|\t/);
  expect(screen().text.split('\n')[0]).toContain(total > 8 ? '1–8/17 · 1/3' : total ? `1–${total}/${total}` : '0–0/0');
  for (const [pair, photo] of photos.entries()) {
    expect(photo).not.toHaveProperty('caption'); expect(photo.photo.media).toMatch(/^telegram:catalog-pair:v1:[a-f0-9]{64}$/);
    const position = rendered.indexOf(photo), open = rendered[position + 1], add = rendered[position + 2], size = Math.min(2, Math.min(total, 8) - pair * 2);
    if (open?.type !== 'buttons' || add?.type !== 'buttons') throw new Error('Real action blocks missing');
    expect(open.buttons.map(button => button.text)).toEqual(Array(size).fill('Открыть товар')); expect(add.buttons.map(button => button.text)).toEqual(Array(size).fill('Добавить в '));
    expect(open.buttons.every(button => button.style === 'primary')).toBe(true); expect(add.buttons.every(button => button.style === 'success')).toBe(true);
    for (let column = 0; column < size; column++) {
      const a = open.buttons[column]!, b = add.buttons[column]!;
      expect(shoppingAction('callback_data' in a ? a.callback_data : '')).toMatchObject({ kind: 'open', productId: 100 + pair * 2 + column, categoryId: 3, page: 0 });
      expect(shoppingAction('callback_data' in b ? b.callback_data : '')).toMatchObject({ kind: 'adjust', productId: 100 + pair * 2 + column, categoryId: 3, page: 0, inCategory: true, delta: 1 });
    }
    expect(vi.mocked(catalog.catalogPair).mock.calls[pair]![0].map(item => item.id)).toEqual(Array.from({ length: size }, (_, column) => 100 + pair * 2 + column));
  }
  expect(rendered.filter(block => block.type === 'buttons').flatMap(block => block.buttons).filter(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'open')).toHaveLength(Math.min(total, 8));
  expect(validScreen(screen())).toBe(true);
});
it('shortens only the long category label, preserving range and page in one paragraph', async () => {
  const { service, db } = setup(17); db.category.findFirst.mockResolvedValueOnce({ name: 'Очень длинное название категории с соленьями и консервами' });
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 1 });
  const header = screen().text.split('\n')[0]!; expect(header).toContain('… · 9–16/17 · 2/3'); expect(header.length).toBeLessThanOrEqual(42);
});
it('preserves full names and server pricing in image identity, with current prices in accessible fallback', async () => {
  const { service, db } = setup(2), name = 'Оливки CEZONI чёрные в рассоле 350 г '.repeat(4);
  db.product.findMany.mockResolvedValueOnce([{ ...product(100), name }, { ...product(101), name: name + ' другой' }]);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  expect(vi.mocked(catalog.catalogPair).mock.calls[0]![0][0]).toMatchObject({ id: 100, name, price: 11000, priceQty: 1, priceUnit: 'PIECE', priceText: '110 ₽/шт.' });
  expect(screen().text).toContain(name); const first = blocks().find(block => block.type === 'photo');
  db.product.findMany.mockResolvedValueOnce([product(100), { ...product(101), price: 12500 }]);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  expect(blocks().find(block => block.type === 'photo')).not.toEqual(first); expect(vi.mocked(catalog.catalogPair).mock.calls[1]![0][1]).toMatchObject({ id: 101, price: 12500, priceText: '125 ₽/шт.' });
});
it('keeps missing/invalid image slots and product/page identity when catalog order changes', async () => {
  const { service, db } = setup(25);
  db.product.findMany.mockResolvedValueOnce([{ ...product(116), images: [] }, { ...product(117), images: [{ url: 'https://evil.example/private.jpg', alt: '' }] }]);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 2 });
  expect(vi.mocked(catalog.catalogPair).mock.calls[0]![0].map(item => item.photo)).toEqual([undefined, undefined]);
  const open = screen().keyboard.inline_keyboard[1]![0]!; if (!('callback_data' in open)) throw new Error('Open missing');
  const action = shoppingAction(open.callback_data); expect(action).toMatchObject({ kind: 'open', productId: 117, page: 2, categoryId: 3 });
  db.product.findMany.mockResolvedValueOnce([product(999)]); await service.handle(target, identity, action!, true);
  expect(db.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 117 }) }));
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:3:2' });
});
it.each(['AVAILABLE', 'INVALID_QUANTITY'] as const)('retains own-product quantity/control bindings for %s', async status => {
  const { service, cart } = setup(2); cart.get.mockResolvedValueOnce({ revision: '11111111-1111-4111-8111-111111111111', items: [{ productId: 101, product: product(101), qty: 3, status, lineTotal: 33000 }] } as Awaited<ReturnType<CartService['get']>>);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  expect(JSON.stringify(blocks())).toContain('В корзине: ');
  const controls = blocks().find(block => block.type === 'buttons' && block.buttons.some(button => button.text === '+' || button.text.includes('Проверить')));
  if (controls?.type !== 'buttons') throw new Error('Quantity row missing');
  if (status === 'AVAILABLE') for (const button of controls.buttons) expect(shoppingAction('callback_data' in button ? button.callback_data : '')).toMatchObject({ productId: 101, page: 0, categoryId: 3 });
  else expect(screen().keyboard.inline_keyboard.flat().some(button => button.text === 'Добавить в ' && 'disabled' in button)).toBe(true);
  expect(validScreen(screen())).toBe(true);
});
it('keeps a full page with eight occupied products within native/HTML and callback limits', async () => {
  const { service, cart } = setup(17);
  cart.get.mockResolvedValueOnce({ revision: '11111111-1111-4111-8111-111111111111', items: Array.from({ length: 8 }, (_, index) => ({
    productId: 100 + index, product: product(100 + index), qty: 3, status: 'AVAILABLE', lineTotal: 33000,
  })) } as Awaited<ReturnType<CartService['get']>>);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  expect(validScreen(screen())).toBe(true); expect(blocks().length).toBeLessThanOrEqual(40);
  for (const button of screen().keyboard.inline_keyboard.flat()) if ('callback_data' in button) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  expect(blocks().filter(block => block.type === 'buttons' && block.buttons.some(button => button.text === '+'))).toHaveLength(8);
});
it('requires phone verification without private cart reads and retains readable HTML/media-free fallback', async () => {
  const { service, cart } = setup(8); await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 }, true);
  expect(cart.get).not.toHaveBeenCalled();
  const adds = blocks().filter(block => block.type === 'buttons').flatMap(block => block.buttons).filter(button => button.text === 'Добавить в ');
  expect(adds).toHaveLength(8); expect(adds.every(button => 'callback_data' in button && button.callback_data === 'verify_phone')).toBe(true);
  const value = screen(); expect(value.mediaFallback!.some(block => block.type === 'photo')).toBe(false); expect(JSON.stringify(value.mediaFallback)).toContain('Товар 100');
  const fallbackRows = value.mediaFallback!.filter(block => block.type === 'buttons');
  expect(fallbackRows).toHaveLength(8);
  for (const row of fallbackRows) {
    expect(row.buttons.map(button => button.text)).toEqual(['Открыть товар', 'Добавить в ']);
    const at = value.mediaFallback!.indexOf(row); expect(value.mediaFallback![at - 1]?.type).toBe('paragraph');
  }
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', 'fixture'); vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', ''); vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', '');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: { message_id: 19 } })); vi.stubGlobal('fetch', fetcher);
  expect(await deliverScreen('customer', target, value)).toMatchObject({ status: 'sent' });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)); expect(body).toMatchObject({ parse_mode: 'HTML', reply_markup: value.keyboard }); expect(body.text).toContain('Товар 100'); expect(body).not.toHaveProperty('rich_message');
});
