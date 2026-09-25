import { customerAction, customerDecision, customerView } from './customer-callback.js';
import { orderCard, issueCard, amount, quantity, siteUrl, webAppUrl, type CustomerOrder, type CustomerIssue } from './customer-view.js';

const id = '12345678-1234-4234-8234-123456789abc';
const item = { id: 1, productName: 'Помидоры', qty: 1000, actualQty: 1200, unit: 'GRAM', total: 10000, actualTotal: 12000, status: 'PICKED' };
const order = {
  id: 7, publicId: id, status: 'READY', type: 'DELIVERY', subtotal: 10000, total: null, finalSubtotal: 12000,
  finalTotal: 16000, payment: { status: 'PAID' }, delivery: { status: 'ASSIGNED' },
  createdAt: new Date(), items: [item], issues: [], extras: [],
} as unknown as CustomerOrder;
const issue = {
  id: 1, version: 2, type: 'WEIGHT_DEVIATION', status: 'WAITING_CUSTOMER', requestedQty: 1000, actualQty: 1200,
  actions: ['ACCEPT_ACTUAL', 'REQUEST_REDUCE', 'REMOVE_ITEM', 'CANCEL_ORDER'],
  orderItem: { productName: 'Помидоры', unit: 'GRAM', price: 10000, priceQty: 1000 },
} as unknown as CustomerIssue;

afterEach(() => vi.unstubAllEnvs());
it('renders requested/actual quantity, final totals, payment and delivery without technical IDs', () => {
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  const card = orderCard(order);
  for (const text of ['1,2 кг', '120 ₽', '160 ₽', 'Получена', 'Курьер назначен', 'Заказ №7']) expect(card.text).toContain(text);
  expect(card.text).not.toContain(id);
  expect(JSON.stringify(card.keyboard)).toContain(id.replaceAll('-', ''));
  expect(card.keyboard.inline_keyboard.flat().find(b => b.text === 'Открыть заказ на сайте'))
    .toEqual({ text: 'Открыть заказ на сайте', web_app: {
      url: 'https://shop.example/telegram?returnTo=' + encodeURIComponent('/order/' + id),
    } });
});
it('renders missing items and finalized extras', () => {
  const card = orderCard({ ...order, items: [{ ...order.items[0]!, status: 'MISSING' }],
    extras: [{ id: 2, title: 'Упаковка', quantity: 2, unitPrice: 1000, amount: 2000, comment: null }] });
  expect(card.text).toContain('Нет в наличии');
  expect(card.text).toContain('Упаковка');
  expect(card.text).toContain('20 ₽');
});
it('shows assembling composition, active extras and the same replacement proposal snapshot as the website', () => {
  const card = orderCard({ ...order, status: 'ASSEMBLING', assemblyFinalizedAt: null,
    finalSubtotal: null, finalTotal: null, items: [item, { ...item, id: 2, productName: 'Клубника', status: 'MISSING', actualQty: 0, actualTotal: 0 }],
    issues: [{ orderItemId: 2, replacementItemId: null, type: 'REPLACEMENT', status: 'WAITING_CUSTOMER',
      resolution: null, actualQty: 0, approvedActualQty: null, proposedName: 'Малина',
      proposedQty: 500, proposedUnit: 'GRAM', proposedPrice: 20000, proposedPriceQty: 1000 }],
    extras: [{ id: 2, title: 'Упаковка', quantity: 1, unitPrice: 30000, amount: 30000, comment: 'Плотный пакет' }],
  } as CustomerOrder);
  for (const value of ['Собрано: 1,2 кг', 'Клубника', 'Нет в наличии', 'Малина',
    '500 г', 'Упаковка', '300 ₽', 'Плотный пакет', 'после сборки']) expect(card.text).toContain(value);
  expect(card.text).not.toContain('Итого:');
});
it('does not present a removed replacement proposal as current', () => {
  const card = orderCard({ ...order, items: [{ ...item, status: 'MISSING' }], issues: [{
    orderItemId: item.id, replacementItemId: null, type: 'REPLACEMENT', status: 'RESOLVED',
    resolution: 'REMOVE_ITEM', actualQty: 0, approvedActualQty: null, proposedName: 'Старая замена',
    proposedQty: 500, proposedUnit: 'GRAM', proposedPrice: 20000, proposedPriceQty: 1000,
  }] } as CustomerOrder);
  expect(card.text).toContain('Нет в наличии');
  expect(card.text).not.toContain('Старая замена');
});
it('paginates a large order and bounds text and every callback', () => {
  const huge = { ...order, items: Array.from({ length: 2000 }, (_, i) => ({ ...order.items[0]!, id: i + 1, productName: 'Я'.repeat(5000) })) };
  for (const page of [0, 1, 399, 2147483647]) {
    const card = orderCard(huge, page);
    expect(card.text.length).toBeLessThan(4096);
    for (const b of card.keyboard.inline_keyboard.flat()) if ('callback_data' in b) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      expect(customerAction(b.callback_data)).not.toBeNull();
    }
  }
});
it('uses authoritative allowed actions and renders replacement snapshot', () => {
  const card = issueCard(order, [{ ...issue, type: 'REPLACEMENT', proposedName: 'Огурцы', proposedSlug: 'cucumber',
    proposedUnit: 'GRAM', proposedQty: 500, proposedPrice: 20000, proposedPriceQty: 1000,
    actions: ['ACCEPT_REPLACEMENT', 'REMOVE_ITEM'] }]);
  expect(card.text).toContain('Заказ №7');
  expect(card.text).toContain('Огурцы');
  expect(card.text).toContain('500 г');
  expect(card.text).toContain('100 ₽');
  expect(card.keyboard.inline_keyboard.flat().some(b => b.text.includes('Принять фактический'))).toBe(false);
});
it('shows no decisions when there is no pending issue', () => {
  const card = issueCard(order, [{ ...issue, actions: [] }]);
  expect(card.text).toContain('нет вопросов');
  expect(card.keyboard.inline_keyboard).toHaveLength(1);
});
it.each([
  ['', null], ['http://shop.example', null], ['https://user:pass@shop.example', null],
  ['https://shop.example?x=1', null], ['https://shop.example#fragment', null],
  ['https://shop.example', 'https://shop.example/profile'],
])('uses only safe HTTPS ORDER_SITE_URL (%s)', (origin, expected) => {
  vi.stubEnv('ORDER_SITE_URL', origin);
  expect(siteUrl('/profile') ?? null).toBe(expected);
  expect(siteUrl('//evil.example')).toBeUndefined();
});
it('WebApp URLs allow only canonical CUSTOMER paths', () => {
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  expect(webAppUrl('/order/' + id)).toBe('https://shop.example/telegram?returnTo=' + encodeURIComponent('/order/' + id));
  for (const path of ['/', '/catalog', '/catalog/vegetables', '/product/green-grapes', '/orders', '/profile', '/cart', '/favorites', '/delivery'])
    expect(webAppUrl(path)).toBe('https://shop.example/telegram?returnTo=' + encodeURIComponent(path));
  for (const path of ['//evil.example', 'https://evil.example', '/product/../admin',
    '/product/a%2Fb', '/product/a?x=1', '/product/a\\b', '/order/not-a-uuid',
    '/admin', '/staff', '/api', '/telegram', '/profile?next=/admin'])
    expect(webAppUrl(path)).toBeUndefined();
});
it('tracking button opens the owned order through WebApp', () => {
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  const tracked = { ...order, delivery: { status: 'ASSIGNED', trackingUrl: 'https://tracking.example/parcel' } } as CustomerOrder;
  const button = orderCard(tracked).keyboard.inline_keyboard.flat().find(b => b.text === 'Отследить доставку');
  expect(button).toEqual({ text: 'Отследить доставку', web_app: {
    url: 'https://shop.example/telegram?returnTo=' + encodeURIComponent('/order/' + id),
  } });
});
it('formats integer kopecks and distinct product units', () => {
  expect(amount(12345)).toBe('123,45 ₽');
  expect(quantity(500, 'GRAM')).toBe('500 г');
  expect(quantity(1500, 'GRAM')).toBe('1,5 кг');
  expect(quantity(2, 'PIECE')).toBe('2 шт.');
  expect(quantity(2, 'BUNCH')).toBe('2 пучка');
  expect(quantity(2, 'PACK')).toBe('2 уп.');
});
it('round-trips exact issue identity and version within 64 bytes', () => {
  const encoded = customerDecision(id, 2147483647, 2147483647, 'p');
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
  expect(customerAction(encoded)).toEqual({ kind: 'd', publicId: id, issueId: 2147483647, version: 2147483647, action: 'ACCEPT_REPLACEMENT' });
  expect(customerAction(customerView('m', id, 2147483647))).toEqual({ kind: 'm', publicId: id, page: 2147483647 });
});
it.each([
  'c:l:-1', 'c:l:zzzzzz', 'c:l:01', 'c:l:1:2', 'c:d:' + id + ':1:1:a',
  'c:d:' + id.replaceAll('-', '') + ':0:1:a',
  'c:d:' + id.replaceAll('-', '') + ':1:0:a',
  'c:d:' + id.replaceAll('-', '') + ':1:1:unknown',
  'order:' + id + '?userId=7', 'a'.repeat(65),
])('rejects malformed/overflow callback %s', data => expect(customerAction(data)).toBeNull());
