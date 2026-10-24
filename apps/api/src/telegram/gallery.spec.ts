import type { DbService } from '../db/db.service.js';
import type { CartService } from '../cart/cart.service.js';
import type { QuickShopService } from '../cart/quick-shop.service.js';
import type { OrderService } from '../order/order.service.js';
import type { CustomerCheckoutService } from './customer-checkout.service.js';
import { CustomerShopService } from './customer-shop.service.js';
import { customerShow } from './customer-send.js';
import { shoppingAction } from './shopping-callback.js';
import { customerScreen, galleryPlaceholder, richMessage, validScreen, type InputRichBlock } from './rich.js';
import { mapPhotos } from './media.js';
import { deliverScreen } from './delivery.js';
import { galleryTablesEnabled } from './rich-policy.js';
import type { RichText, RichMessageButton } from './rich.js';

vi.mock('./customer-send.js', () => ({ customerShow: vi.fn(async () => true) }));
vi.mock('./rich-policy.js', () => ({ galleryTablesEnabled: vi.fn(async () => false), richEnabled: vi.fn(async () => false) }));
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
const productRows = () => richMessage(customerScreen(screen())).blocks.filter((block): block is Extract<InputRichBlock, { type: 'buttons' }> =>
  block.type === 'buttons' && block.buttons.some(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'open'));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(galleryTablesEnabled).mockResolvedValue(false); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const textButtons = (text: RichText): RichMessageButton[] => typeof text === 'string' ? [] : Array.isArray(text)
  ? text.flatMap(textButtons) : text.type === 'button' ? [text.button] : textButtons(text.text);
it.each([0, 1, 3, 8, 17])('shows accepted table galleries for %s products without duplicate root actions', async total => {
  vi.mocked(galleryTablesEnabled).mockResolvedValue(true);
  const { service } = setup(total);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const blocks = richMessage(customerScreen(screen())).blocks;
  const tables = blocks.filter(block => block.type === 'table');
  expect(tables).toHaveLength(Math.ceil(Math.min(total, 8) / 2));
  expect(productRows()).toHaveLength(0); expect(cells()).toHaveLength(tables.length * 2);
  for (const table of tables) {
    expect(table.is_compact).toBe(true); expect(table.cells.map(row => row.length)).toEqual([2, 2]);
    expect(blocks[blocks.indexOf(table) - 1]?.type).toBe('collage');
    expect(Object.keys(table).sort()).toEqual(['cells', 'is_compact', 'type']);
  }
  const opens = tables.flatMap(table => table.cells[0]!.flatMap(cell => textButtons(cell.text)));
  expect(opens).toHaveLength(Math.min(total, 8));
  if (total % 2 && total < 8) expect(tables.at(-1)?.cells.map(row => row[1]!.text)).toEqual(['', '']);
  expect(validScreen(screen())).toBe(true);
});
it('keeps full names, bold current prices and exact add labels in their own photo column', async () => {
  vi.mocked(galleryTablesEnabled).mockResolvedValue(true);
  const { service, db } = setup(2);
  const name = 'Очень длинное название товара '.repeat(8);
  db.product.findMany.mockResolvedValueOnce([{ ...product(100), name }, { ...product(101), price: 12500 }]);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const table = richMessage(customerScreen(screen())).blocks.find(block => block.type === 'table');
  if (table?.type !== 'table') throw new Error('Table missing');
  const open = textButtons(table.cells[0]![0]!.text)[0]!;
  expect(open.text).toBe(name); expect(open.style).toBe('link');
  expect(table.cells[0]![1]!.text).toContainEqual({ type: 'bold', text: '125 ₽ / 1 шт.' });
  for (const [index, cell] of table.cells[1]!.entries()) {
    const add = textButtons(cell.text)[0]!;
    expect(add.text).toBe('Добавить в ');
    expect(shoppingAction('callback_data' in add ? add.callback_data : '')).toMatchObject({ kind: 'adjust', productId: 100 + index, page: 0, categoryId: 3 });
  }
  expect(JSON.stringify(table)).not.toMatch(/Слева|Справа|…/);
  expect(validScreen(screen())).toBe(true);
});
it('keeps acknowledged quantity and minus/plus inside the correct table cell', async () => {
  vi.mocked(galleryTablesEnabled).mockResolvedValue(true);
  const { service, cart } = setup(2);
  cart.get.mockResolvedValueOnce({ revision: '11111111-1111-4111-8111-111111111111', items: [{ productId: 101, product: product(101), qty: 3, status: 'AVAILABLE', lineTotal: 33000 }] } as Awaited<ReturnType<CartService['get']>>);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const table = richMessage(customerScreen(screen())).blocks.find(block => block.type === 'table');
  if (table?.type !== 'table') throw new Error('Table missing');
  expect(textButtons(table.cells[0]![0]!.text)).toHaveLength(1);
  expect(JSON.stringify(table.cells[0]![1])).toContain('🛒 3 шт.');
  const buttons = textButtons(table.cells[0]![1]!.text);
  expect(buttons.map(button => button.text)).toEqual(['Товар 101', '−', '+']);
  for (const button of buttons) expect(shoppingAction('callback_data' in button ? button.callback_data : '')).toMatchObject({ productId: 101 });
  expect(productRows()).toHaveLength(0);
  const duplicated = richMessage(customerScreen(screen())).blocks.filter(block => block.type === 'buttons' && block.buttons.some(button => button.text === '−'));
  expect(duplicated).toHaveLength(0);
});
it('keeps table onboarding and the complete HTML keyboard without private reads', async () => {
  vi.mocked(galleryTablesEnabled).mockResolvedValue(true);
  const { service, cart } = setup(2);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 }, true);
  expect(cart.get).not.toHaveBeenCalled();
  const table = richMessage(customerScreen(screen())).blocks.find(block => block.type === 'table');
  if (table?.type !== 'table') throw new Error('Table missing');
  expect(table.cells[1]!.flatMap(cell => textButtons(cell.text))).toEqual([
    { text: 'Добавить в ', callback_data: 'verify_phone' }, { text: 'Добавить в ', callback_data: 'verify_phone' },
  ]);
  expect(screen().keyboard.inline_keyboard.flat().filter(button => button.text === 'Добавить в ')).toHaveLength(2);
  expect(screen().keyboard.inline_keyboard[0]![0]!.text).toContain('110 ₽');
});

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
  const selection = productRows().flatMap(row => row.buttons)
    .filter(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'open');
  expect(selection).toHaveLength(Math.min(total, 8));
  expect(productRows()).toHaveLength(Math.min(total, 8));
  expect(cells().every(photo => photo.caption === undefined)).toBe(true);
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
it('keeps visible A/B buttons directly after each two-photo collage through the real customer renderer', async () => {
  const { service } = setup(8);
  await service.handle(target, identity, { kind: 'products', categoryId: 3, page: 0 });
  const photos = cells(), blocks = richMessage(customerScreen(screen())).blocks;
  for (let index = 0; index < 8; index++) {
    const photo = photos[index]!;
    expect(photo.photo.media).toBe('https://shop.example/uploads/products/item-' + (100 + index) + '.webp');
    const at = 2 + Math.floor(index / 2) * 3;
    expect(blocks[at]?.type).toBe('collage');
    const row = blocks[at + 1 + index % 2];
    if (row?.type !== 'buttons') throw new Error('Visible product buttons missing after collage');
    const buttons = row.buttons;
    expect(row.align).toBe('left');
    expect(buttons.map(button => button.text)).toEqual([(index % 2 === 0 ? 'Слева · ' : 'Справа · ') + 'Товар ' + (100 + index) + ' · 110 ₽ / 1 шт.', 'Добавить в 🛒']);
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
  expect(screen().keyboard.inline_keyboard[1]![0]!.text).toBe('Справа · Товар 101 · 125 ₽ / 1 шт.');
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
  const value = screen(), photos = cells(), rows = productRows(), blocks = richMessage(customerScreen(value)).blocks;
  for (let index = 0; index < 8; index++) {
    const photo = photos[index]!, row = rows[index]!, buttons = row.buttons;
    expect(photo.photo.media).toContain('item-' + (index + 108) + '.webp');
    expect(buttons[0]!.text).toContain('🛒 3 шт.');
    expect(buttons[1]!.text).toBe('Добавить в 🛒');
    const controls = blocks[blocks.findIndex(block => block.type === 'buttons' && block.buttons === row.buttons) + 1];
    if (controls?.type !== 'buttons') throw new Error('Visible quantity controls missing');
    if (status === 'AVAILABLE') {
      expect(controls.buttons.map(button => button.text)).toEqual(['−', '+']);
      for (const button of [...buttons, ...controls.buttons])
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
  const buttons = productRows()[3]!.buttons;
  expect(buttons[0]!.text).toContain('Справа · ');
  for (const button of buttons) if ('callback_data' in button) expect(shoppingAction(button.callback_data)).toMatchObject({ productId: 103 });
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
