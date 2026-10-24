import { customerAction, customerDecision, customerConfirmCancellation, customerView } from './customer-callback.js';
import { orderCard, issueCard, customerMenu, customerOnboardingMenu, cancelOrderScreen, addressLines, short, amount, quantity, siteUrl, webAppUrl, type CustomerOrder, type CustomerIssue } from './customer-view.js';

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
  for (const text of ['1,2 кг', '120 ₽', '160 ₽', 'Оплата получена', 'Курьер назначен', 'Заказ №7']) expect(card.text).toContain(text);
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
it('shows exact weight and server price deltas with a versioned acceptance label', () => {
  const card = issueCard(order, [issue]);
  expect(card.text).toContain('Изменение веса: +200 г');
  expect(card.text).toContain('Изменение стоимости: +20 ₽');
  const accept = card.keyboard.inline_keyboard.flat().find(button =>
    'callback_data' in button && customerAction(button.callback_data)?.kind === 'd' && button.callback_data.endsWith(':a'));
  expect(accept).toEqual({ text: '✅ Принять 1,2 кг · 120 ₽', style: 'success',
    callback_data: customerDecision(id, 1, 2, 'a') });
  expect(card.keyboard.inline_keyboard.flat().find(button => 'callback_data' in button && button.callback_data.endsWith(':x')))
    .toMatchObject({ text: 'Убрать только этот товар', style: 'danger' });
});
it('keeps quantity and price changes distinct when the seller changes the actual price', () => {
  const card = issueCard(order, [{ ...issue, actualQty: 900,
    orderItem: { ...issue.orderItem, actualPrice: 12000 } }]);
  expect(card.text).toContain('Изменение веса: −100 г');
  expect(card.text).toContain('По факту: 108 ₽');
  expect(card.text).toContain('Изменение стоимости: +8 ₽');
  expect(card.keyboard.inline_keyboard[0]?.[0]?.text).toBe('✅ Принять 900 г · 108 ₽');
});
it('prices whole variable items by actual grams while preserving counts and unknown requested sums', () => {
  const whole = { ...issue, orderItemId: 1, requestedQty: 2, actualQty: 2, actualWeightGrams: 1500,
    orderItem: { ...issue.orderItem, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceUnit: 'GRAM', price: 50000 } } as CustomerIssue;
  const card = issueCard({ ...order, items: [{ ...order.items[0]!, id: 1, qty: 2, total: null }] }, [whole]);
  for (const text of ['Заказано: 2 шт.', 'Фактически: 2 шт. · 1,5 кг', 'Цена: 500 ₽ / 1 кг',
    'Изменение количества: 0 шт.', 'При заказе: сумма после взвешивания', 'По факту: 750 ₽', 'Изменение стоимости: уточняется'])
    expect(card.text).toContain(text);
  expect(card.text).not.toContain('Изменение веса:');
  expect(card.keyboard.inline_keyboard[0]?.[0]?.text).toBe('✅ Принять 2 шт. · 1,5 кг · 750 ₽');
  expect(card.keyboard.inline_keyboard.flat().some(button => button.text === '⚖️ Попросить другой экземпляр')).toBe(true);
});
it('uses an original whole-item snapshot estimate only when it is known', () => {
  const card = issueCard({ ...order, items: [{ ...order.items[0]!, id: 1, qty: 1, total: 40000 }] }, [{
    ...issue, orderItemId: 1, requestedQty: 1, actualQty: 1, actualWeightGrams: 900,
    orderItem: { ...issue.orderItem, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', price: 50000 },
  } as CustomerIssue]);
  expect(card.text).toContain('При заказе: 400 ₽');
  expect(card.text).toContain('По факту: 450 ₽');
  expect(card.text).toContain('Изменение стоимости: +50 ₽');
});
it('does not turn a whole replacement count into grams or an unknown price into zero', () => {
  const card = issueCard(order, [{ ...issue, type: 'REPLACEMENT', proposedName: 'Рыба целиком', proposedSlug: 'fish',
    proposedUnit: 'PIECE', proposedPriceUnit: 'GRAM', proposedSaleModel: 'WHOLE_VARIABLE_WEIGHT',
    proposedQty: 1, proposedPrice: 50000, proposedPriceQty: 1000, proposedEstimatedWeightGrams: null,
    actions: ['ACCEPT_REPLACEMENT', 'REMOVE_ITEM'] }]);
  expect(card.text).toContain('Количество: 1 кг → 1 шт.');
  expect(card.text).toContain('Цена замены: 500 ₽ / 1 кг');
  expect(card.text).toContain('Сумма замены: сумма после взвешивания');
  expect(card.text).toContain('Изменение стоимости: уточняется');
  expect(card.text).not.toContain('Сумма замены: 0 ₽');
  expect(card.keyboard.inline_keyboard.flat()).toContainEqual({
    text: 'Убрать только этот товар', style: 'danger', callback_data: customerDecision(id, 1, 2, 'x'),
  });
  expect(card.keyboard.inline_keyboard[0]?.[0]).toEqual({
    text: '✅ Заменить: 1 шт. · сумма после взвешивания', style: 'success',
    callback_data: customerDecision(id, 1, 2, 'p'),
  });
});
it('calculates a replacement estimate from its own server sale and weight snapshot', () => {
  const card = issueCard(order, [{ ...issue, type: 'REPLACEMENT', proposedName: 'Рыба', proposedSlug: 'fish',
    proposedUnit: 'PIECE', proposedPriceUnit: 'GRAM', proposedSaleModel: 'WHOLE_VARIABLE_WEIGHT',
    proposedQty: 2, proposedPrice: 50000, proposedPriceQty: 1000, proposedEstimatedWeightGrams: 600,
    actions: ['ACCEPT_REPLACEMENT'] }]);
  expect(card.text).toContain('Сумма замены: 600 ₽');
  expect(card.text).toContain('Изменение стоимости: +500 ₽');
  expect(card.keyboard.inline_keyboard[0]?.[0]).toMatchObject({ text: '✅ Заменить: 2 шт. · 600 ₽', style: 'success' });
});
it('renders only permitted actions and never presents a resolved issue as actionable', () => {
  const card = issueCard(order, [{ ...issue, actions: ['REQUEST_REDUCE'] },
    { ...issue, id: 2, status: 'RESOLVED', actions: ['ACCEPT_ACTUAL'] }]);
  const decisions = card.keyboard.inline_keyboard.flat().flatMap(button => 'callback_data' in button
    ? [customerAction(button.callback_data)].filter(action => action?.kind === 'd') : []);
  expect(decisions).toEqual([{ kind: 'd', publicId: id, issueId: 1, version: 2, action: 'REQUEST_REDUCE' }]);
  expect(card.keyboard.inline_keyboard[0]?.[0]?.style).toBeUndefined();
  expect(card.text).not.toContain('2 из');
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
  for (const path of ['/', '/catalog', '/quick-shop', '/catalog/vegetables', '/product/green-grapes', '/orders', '/profile', '/cart', '/favorites', '/delivery'])
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


it('prioritizes actionable questions above the current order, cart and shopping shortcuts', () => {
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  const card = customerMenu({ firstName: null, user: { name: 'Покупатель' } }, {
    attention: { id: 7, customerUnread: 2, issues: [{ id: 1 }] }, current: { id: 7, status: 'ASSEMBLING' },
    cartLabel: '🛒 Корзина · 2 поз. · ≈ 400 ₽',
  });
  expect(card.text).not.toContain('№7');
  expect(card.keyboard.inline_keyboard[0]?.[0]).toMatchObject({ callback_data: 'attention', style: 'primary' });
  expect(card.keyboard.inline_keyboard.flat().filter(button => button.text.includes('№7'))).toHaveLength(1);
  expect(card.keyboard.inline_keyboard[1]?.[0]).toMatchObject({ callback_data: 'catalog' });
  expect(card.keyboard.inline_keyboard[1]?.[1]).toMatchObject({ callback_data: 'cart' });
  expect(card.keyboard.inline_keyboard[2]?.map(button => 'callback_data' in button ? button.callback_data : '')).toEqual(['s:q:0', 'orders']);
  expect(card.keyboard.inline_keyboard[3]?.[0]).toMatchObject({ callback_data: 'delivery' });
});

it('onboarding exposes browsing and help without claiming an order session is ready', () => {
  const card = customerOnboardingMenu({ firstName: 'Анна', user: { name: null } });
  expect(card.text).toContain('Привет, Анна!');
  expect(card.text).toContain('подтвердите свой номер');
  const actions = card.keyboard.inline_keyboard.flat().flatMap(button => 'callback_data' in button ? [button.callback_data] : []);
  expect(actions).toEqual(['catalog', 'verify_phone', 'help']);
});

it('formats delivery details with explicit labels and a separate comment', () => {
  expect(addressLines({ city: 'Москва', street: 'Тестовая', house: '1', flat: '12', entrance: '2', floor: '5', intercom: '12К', comment: 'Позвоните' }))
    .toEqual(['📍 Москва, ул. Тестовая, д. 1', 'кв. 12 · подъезд 2 · этаж 5 · домофон 12К', 'Комментарий: Позвоните']);
});

it('presents questions as the first action without offering payment during unfinished assembly', () => {
  const card = orderCard({ ...order, status: 'ASSEMBLING', assemblyFinalizedAt: null, payment: null,
    issues: [{ ...order.issues[0], status: 'WAITING_CUSTOMER' }] } as CustomerOrder);
  expect(card.text).toContain('Следующий шаг: ответьте на вопросы');
  expect(card.keyboard.inline_keyboard[0]?.[0]).toMatchObject({ callback_data: customerView('q', id), style: 'primary' });
});

it('shows authoritative payable amount and a payment next step after finalized assembly', () => {
  const card = orderCard({ ...order, assemblyFinalizedAt: new Date(), payment: { ...order.payment!, status: 'AWAITING', amount: 12000 } });
  expect(card.text).toContain('переведите точную сумму');
  expect(card.keyboard.inline_keyboard[0]?.[0]).toMatchObject({ text: '💳 Оплата · 120 ₽', style: 'primary' });
});

it('never urges another transfer while the payment is being verified', () => {
  const card = orderCard({ ...order, assemblyFinalizedAt: new Date(), payment: { ...order.payment!, status: 'REPORTED', amount: 12000 } });
  expect(card.text).toContain('Повторно переводить деньги не нужно');
  expect(card.keyboard.inline_keyboard[0]?.[0]?.text).toBe('🕓 Проверка оплаты');
});

it('shows actual grams alongside piece count for whole variable-weight items', () => {
  const card = orderCard({ ...order, items: [{ ...order.items[0]!, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', qty: 2, actualQty: 2, actualWeightGrams: 1500 }] });
  expect(card.text).toContain('Собрано: 2 шт. · 1,5 кг');
});

it('does not invent a replacement total from a whole-item count without the full sale snapshot', () => {
  const card = orderCard({ ...order, issues: [{ orderItemId: item.id, status: 'WAITING_CUSTOMER', type: 'REPLACEMENT',
    proposedName: 'Рыба целиком', proposedUnit: 'PIECE', proposedQty: 1, proposedPrice: 50000, proposedPriceQty: 1000 }] } as CustomerOrder);
  expect(card.text).toContain('Рыба целиком · 1 шт.');
  expect(card.text).not.toContain('0,50 ₽');
});

it('keeps confirmed cancellation versioned, bounded, and distinct from the legacy request', () => {
  const card = cancelOrderScreen(order, issue);
  const button = card.keyboard.inline_keyboard.flat().find(button => 'callback_data' in button && button.callback_data.startsWith('c:y:'))!;
  if (!('callback_data' in button)) throw new Error('Expected cancellation callback');
  expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  expect(customerAction(button.callback_data)).toEqual({ kind: 'd', publicId: id, issueId: 1, version: 2, action: 'CANCEL_ORDER', confirmed: true });
  expect(customerAction(customerConfirmCancellation(id, 2147483647, 2147483647))).not.toBeNull();
  expect(customerAction(customerConfirmCancellation(id, 1, 2).replace(/:c$/, ':a'))).toBeNull();
  expect(customerAction('c:n:1')).toEqual({ kind: 'attention', page: 1 });
  expect(customerAction('c:n:zzzzzz')).toBeNull();
});

it('never truncates a Unicode name in the middle of a surrogate pair', () => {
  const value = short('😀'.repeat(91), 180);
  expect(value.length).toBeLessThanOrEqual(180);
  expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});


it('fits long delivery details and replacement snapshots without dropping products or totals', () => {
  const detailed = { ...order, customerName: 'Н'.repeat(100), customerPhone: '+79990000000',
    city: 'Г'.repeat(100), street: 'У'.repeat(150), house: 'Д'.repeat(30), buildingPart: 'К'.repeat(50),
    flat: '1'.repeat(20), entrance: '2'.repeat(20), floor: '3'.repeat(20), intercom: '4'.repeat(30), comment: 'П'.repeat(300),
    items: Array.from({ length: 50 }, (_, index) => ({ ...item, id: index + 1, productName: 'Т'.repeat(180), price: 10000, actualPrice: 11000 })),
    issues: Array.from({ length: 50 }, (_, index) => ({ orderItemId: index + 1, replacementItemId: null, type: 'REPLACEMENT', status: 'WAITING_CUSTOMER',
      proposedName: 'З'.repeat(180), proposedUnit: 'GRAM', proposedQty: 500, proposedPrice: 20000, proposedPriceQty: 1000 })),
  } as CustomerOrder;
  for (const page of [0, 1, 10, 2147483647]) {
    const card = orderCard(detailed, page);
    expect(card.text.length).toBeLessThanOrEqual(4096);
    expect(card.text).toContain('Итого: 160 ₽');
    expect(card.text).toContain('Комментарий:');
  }
});
