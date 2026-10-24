import type { DbService } from '../db/db.service.js';
import type { CartService } from '../cart/cart.service.js';
import type { QuickShopService } from '../cart/quick-shop.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerShopService } from './customer-shop.service.js';
import { customerShow } from './customer-send.js';
import { shoppingAction } from './shopping-callback.js';
import { galleryPlaceholder, richMessage, validScreen, type InputRichBlock, type RichText, type TelegramButton } from './rich.js';
import { mapPhotos } from './media.js';
import { deliverScreen } from './delivery.js';

vi.mock('./customer-send.js', () => ({ customerShow: vi.fn(async () => true) }));
const target = { chatId: 123 }, identity = { id: 1, userId: 2 };
const product = (id: number) => ({ id, name: 'Товар ' + id, slug: 'item-' + id, unit: 'PIECE' as const,
  priceUnit: 'PIECE' as const, saleModel: 'PIECE_FIXED' as const, price: 11000, priceQty: 1,
  priceStatus: 'SOURCE' as const, serviceMarkupPercent: 0, min: 1, step: 1, portionQty: 1,
  estimatedWeightGrams: null, marketPoint: null, categoryId: 3,
  images: [{ url: '/uploads/products/item-' + id + '.webp', alt: '' }] });
function setup(total: number, missing = -1) {
  const db = { category: { findFirst: vi.fn(async () => ({ name: 'Фрукты' })), findMany: vi.fn(async () => [{ id: 3 }]) },
    product: { count: vi.fn(async () => total), findMany: vi.fn(async ({ skip, take }: { skip: number; take: number }) =>
      Array.from({ length: Math.max(0, Math.min(take, total - skip)) }, (_, index) => {
        const row = product(skip + index + 100);
        return { ...row, images: row.id === missing ? [] : row.images };
      })), findFirst: vi.fn(async ({ where }: { where: { id: number } }) => product(where.id)) }, $transaction: vi.fn() };
  db.$transaction.mockImplementation(async (run: (db: unknown) => Promise<unknown>) => run(db));
  const cart = { get: vi.fn(async () => ({ revision: '11111111-1111-4111-8111-111111111111', items: [], goodsTotal: 0 }) as Awaited<ReturnType<CartService['get']>>) };
  const service = new CustomerShopService(db as unknown as DbService, cart as unknown as CartService, {} as CustomerCheckoutService, {} as OrderService, {} as QuickShopService);
  return { db, service, cart };
}
const screen = () => vi.mocked(customerShow).mock.calls.at(-1)![1];
const cells = () => richMessage(screen()).blocks.flatMap(block => block.type === 'collage' ? block.blocks : [])
  .filter((block): block is Extract<InputRichBlock, { type: 'photo' }> => block.type === 'photo');
function captionButtons(text: RichText): TelegramButton[] {
  if (typeof text === 'string') return [];
  if (Array.isArray(text)) return text.flatMap(captionButtons);
  return text.type === 'button' ? [text.button] : captionButtons(text.text);
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([0, 1, 3, 8, 17])('shows %s products in pairs without a duplicate text list or single-page label', async total => {
  const { service } = setup(total);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const value = screen(), rich = richMessage(value), photos: string[] = [];
  mapPhotos(rich.blocks, photo => { photos.push(photo.photo.media); return photo; });
  expect(photos.filter(media => media !== galleryPlaceholder)).toHaveLength(Math.min(total, 8));
  expect(value.text).not.toContain('Товар 100');
  expect(value.text.includes('Страница')).toBe(total > 8);
  expect(validScreen(value)).toBe(true);
  for (const block of rich.blocks) if (block.type === 'collage') expect(block.blocks).toHaveLength(2);
  expect(rich.blocks.some(block => block.type === 'photo')).toBe(false);
  expect(value.thumbnailPhotos).toBe(true);
  const selection = cells().flatMap(photo => captionButtons(photo.caption?.text ?? ''))
    .filter(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'open');
  expect(selection).toHaveLength(Math.min(total, 8));
  expect(rich.blocks.filter(block => block.type === 'buttons').flatMap(block => block.buttons)
    .some(button => 'callback_data' in button && ['open', 'adjust'].includes(shoppingAction(button.callback_data)?.kind ?? ''))).toBe(false);
});
it.each([{ images: [] }, { images: [{ url: 'https://evil.example/private.jpg', alt: '' }] }])('uses every original button when a photo is absent or invalid', async ({ images }) => {
  const { db, service } = setup(8, 103);
  if (images.length) db.product.findMany.mockResolvedValueOnce(Array.from({ length: 8 }, (_, i) => ({ ...product(i + 100), images: i === 3 ? images : product(i + 100).images })));
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  expect(cells()[3]?.photo.media).toBe(galleryPlaceholder);
  expect(cells()).toHaveLength(8);
  expect(screen().keyboard.inline_keyboard.flat().filter(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'open')).toHaveLength(8);
});
it('binds each selection to its real ID and retains the page even if catalog ordering changes', async () => {
  const { service, db } = setup(25);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 2 });
  const button = screen().keyboard.inline_keyboard[1]![0]!;
  if (!('callback_data' in button)) throw new Error('No callback');
  const action = shoppingAction(button.callback_data);
  expect(action).toMatchObject({ kind: 'open', productId: 117, page: 2, origin: 'category' });
  db.product.findMany.mockResolvedValueOnce([product(999)]);
  if (!action) throw new Error('No action');
  await service.handle(target, identity, action, true);
  expect(db.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 117 }) }));
  expect(screen().keyboard.inline_keyboard.flat()).toContainEqual({ text: '← К товарам', callback_data: 's:l:3:2' });
});
it('disambiguates identical truncated names with stable product identifiers', async () => {
  const { service, db } = setup(2);
  db.product.findMany.mockResolvedValueOnce([101,102].map(id => ({ ...product(id), name: 'Очень длинное название одного и того же вида продукции ' + id })));
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const first = screen().keyboard.inline_keyboard[0]![0], second = screen().keyboard.inline_keyboard[1]![0];
  expect(first!.text).not.toBe(second!.text);
  expect(first!.text).toContain('№101'); expect(second!.text).toContain('№102');
});
it('binds both native caption buttons to their own photo/product inside strictly two-photo collages', async () => {
  const { service } = setup(8);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const photos = cells();
  for (let index = 0; index < 8; index++) {
    const photo = photos[index]!;
    expect(photo.photo.media).toBe('https://shop.example/uploads/products/item-' + (100 + index) + '.webp');
    const buttons = captionButtons(photo.caption!.text);
    expect(buttons.map(button => button.text)).toEqual(['Товар ' + (100 + index) + ' · 110 ₽ / 1 шт.', 'Добавить в 🛒']);
    expect(buttons.map(button => 'callback_data' in button ? shoppingAction(button.callback_data) : null)).toEqual([
      { kind: 'open', productId: 100 + index, origin: 'category', categoryId: 3, page: 0 },
      { kind: 'adjust', productId: 100 + index, origin: 'category', categoryId: 3, page: 0,
        delta: 1, quantityUnit: 'PIECE', revision: '11111111-1111-4111-8111-111111111111', inCategory: true },
    ]);
  }
});
it('refreshes button prices without baking text into or replacing the product photograph', async () => {
  const { service, db } = setup(2);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const initial = cells().map(photo => photo.photo);
  db.product.findMany.mockResolvedValueOnce([product(100), { ...product(101), price: 12500 }]);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  expect(screen().keyboard.inline_keyboard[1]![0]!.text).toBe('Товар 101 · 125 ₽ / 1 шт.');
  expect(cells().map(photo => photo.photo)).toEqual(initial);
});
it('offers phone verification for every public add button without reading the private basket', async () => {
  const { service, cart } = setup(8);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 }, true);
  expect(cart.get).not.toHaveBeenCalled();
  const buttons = screen().keyboard.inline_keyboard.flat();
  expect(buttons.filter(button => 'callback_data' in button && button.callback_data === 'verify_phone')).toHaveLength(8);
  expect(buttons.filter(button => 'callback_data' in button && button.callback_data === 'verify_phone').every(button => button.text === 'Добавить в 🛒')).toBe(true);
  expect(buttons.some(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'adjust')).toBe(false);
});
it.each(['AVAILABLE', 'INVALID_QUANTITY'] as const)('keeps the exact add label and separates controls after adding, with %s sale terms', async status => {
  const { service, cart } = setup(25);
  cart.get.mockResolvedValueOnce({ revision: '11111111-1111-4111-8111-111111111111', items: Array.from({ length: 8 }, (_, index) => ({
    productId: index + 108, product: product(index + 108), qty: 3, status, lineTotal: 33000,
  })) } as unknown as Awaited<ReturnType<CartService['get']>>);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 1 });
  const value = screen(), photos = cells();
  for (let index = 0; index < 8; index++) {
    const photo = photos[index]!, buttons = captionButtons(photo.caption!.text);
    expect(photo.photo.media).toContain('item-' + (index + 108) + '.webp');
    expect(buttons[0]!.text).toContain('🛒 3 шт.');
    expect(buttons[1]!.text).toBe('Добавить в 🛒');
    if (status === 'AVAILABLE') {
      expect(buttons.slice(2).map(button => button.text)).toEqual(['−', '+']);
      for (const button of buttons)
        if ('callback_data' in button) expect(shoppingAction(button.callback_data)).toMatchObject({ productId: index + 108, page: 1 });
    } else expect(buttons[1]).toHaveProperty('disabled');
  }
  expect(validScreen(value)).toBe(true);
  expect(value.keyboard.inline_keyboard.flat()).toContainEqual({ text: '← Предыдущие товары', callback_data: 's:l:3:0' });
  expect(value.keyboard.inline_keyboard.flat()).toContainEqual({ text: 'Следующие товары →', callback_data: 's:l:3:2' });
});
it('keeps other product photos and button positions when one product has no photograph', async () => {
  const { service } = setup(8, 103);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const photos = cells();
  expect(photos).toHaveLength(8);
  expect(photos[3]!.photo.media).toBe(galleryPlaceholder);
  expect(JSON.stringify(photos[3]!.caption)).toContain('Фото недоступно');
  for (const button of captionButtons(photos[3]!.caption!.text)) if ('callback_data' in button) expect(shoppingAction(button.callback_data)).toMatchObject({ productId: 103 });
});
it('retains exact open/add product bindings and inline rows in HTML fallback', async () => {
  const { service } = setup(8);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const value = screen();
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', 'fixture'); vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', ''); vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', '');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: { message_id: 19 } })); vi.stubGlobal('fetch', fetcher);
  expect(await deliverScreen('customer', target, value)).toMatchObject({ status: 'sent' });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({ parse_mode: 'HTML', reply_markup: value.keyboard });
  expect(body).not.toHaveProperty('rich_message'); expect(body.text).not.toContain('Товар 100');
});
