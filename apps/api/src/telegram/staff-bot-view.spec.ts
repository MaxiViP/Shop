import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canReview, extraPage, nextStaffAction, reviewView, staffHelp, workOverview, assemblyProgress, assemblyView, dashboard, issuePage, itemPage, itemView, nextAssemblyItem, staffWeighUrl, type OrderView } from './staff-bot-view.js';
import { richMessage } from './rich.js';

function fixture(): OrderView {
  return {
    id: 6, status: 'ASSEMBLING',
    items: [
      { id: 1, productName: 'Киви', qty: 3, unit: 'PIECE', status: 'PENDING' },
      { id: 2, productName: 'Клубника', qty: 1, unit: 'PACK', status: 'PENDING' },
      { id: 3, productName: 'Лук зелёный', qty: 2, unit: 'BUNCH', status: 'PENDING' },
      { id: 4, productName: 'Виноград', qty: 500, unit: 'GRAM', status: 'PENDING' },
      { id: 5, productName: 'Огурцы', qty: 2, unit: 'PIECE', status: 'PICKED' },
      { id: 6, productName: 'Авокадо', qty: 1, unit: 'PIECE', status: 'MISSING' },
    ], issues: [], extras: [],
  } as unknown as OrderView;
}

function buttons(view: { keyboard: { inline_keyboard: ({ text: string; callback_data?: string } | { text: string; url: string })[][] } }) {
  return view.keyboard.inline_keyboard.flat();
}

it('places Refresh, customer chat and web order links in that order', () => {
  const order = fixture();
  order.customerName = 'Тест'; order.customerPhone = '+79990000000';
  const actions = buttons(dashboard(order, 'https://shop.example/staff/orders/6'));
  expect(actions.slice(-3).map(button => button.text)).toEqual(['🔄 Обновить', 'Чат с покупателем', 'Открыть заказ на сайте']);
  expect(actions.at(-2)).toEqual({ text: 'Чат с покупателем', url: 'https://shop.example/staff/orders/6#order-chat' });
});

describe('STAFF position list', () => {
  it('shows requested quantity, unit and state for all positions', () => {
    const view = itemPage(fixture(), 0);
    const labels = buttons(view).map(button => button.text);
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('Киви — 3 шт. · в сборке'),
      expect.stringContaining('Клубника — 1 уп. · в сборке'),
      expect.stringContaining('Лук зелёный — 2 пучка · в сборке'),
      expect.stringContaining('Виноград — 500 г · нужен вес'),
      expect.stringContaining('Огурцы — 2 шт. · собран'),
      expect.stringContaining('Авокадо — 1 шт. · нет в наличии'),
    ]));
    expect(view.text).toContain('6 из 6');
  });

  it.each(['PIECE', 'PACK', 'BUNCH'] as const)('offers instant and manual input for %s', unit => {
    const order = fixture();
    const item = order.items.find(value => value.unit === unit)!;
    const view = itemView(order, item);
    expect(buttons(view).map(button => button.text)).toContain('✅ По заказу');
    expect(buttons(view).map(button => button.text)).toContain('✏️ Изменить количество');
    expect(buttons(view).map(button => button.text)).toContain('❌ Нет в наличии');
    expect(buttons(itemPage(order, 0)).some(button =>
      'callback_data' in button && button.callback_data === 's:6:a:' + item.id)).toBe(true);
  });

  it('requires an actual weight for GRAM and keeps bulk action available', () => {
    const order = fixture();
    const weighted = order.items.find(item => item.unit === 'GRAM')!;
    expect(buttons(itemView(order, weighted)).map(button => button.text)).toContain('⚖️ Ввести вес');
    expect(buttons(itemView(order, weighted)).map(button => button.text)).not.toContain('✅ По заказу');
    const page = itemPage(order, 0);
    expect(buttons(page).some(button =>
      'callback_data' in button && button.callback_data === 's:6:a:4')).toBe(false);
    expect(buttons(dashboard(order)).some(button =>
      'callback_data' in button && button.callback_data === 's:6:k')).toBe(true);
  });

  it('does not offer quick pick for processed or issue-linked positions', () => {
    const order = fixture();
    (order.issues as { orderItemId: number; replacementItemId: number | null }[]).push({
      orderItemId: 1, replacementItemId: null,
    });
    const callbacks = buttons(itemPage(order, 0)).flatMap(button =>
      'callback_data' in button ? [button.callback_data] : []);
    expect(callbacks).not.toContain('s:6:a:1');
    expect(callbacks).not.toContain('s:6:a:5');
    expect(callbacks).not.toContain('s:6:a:6');
  });
});

it.each(['PIECE', 'BUNCH'] as const)('routes weighed %s items to the website without offering invalid confirmations', unit => {
  const order = fixture();
  const item = { ...order.items[0]!, unit, priceUnit: 'GRAM' as const,
    saleModel: unit === 'PIECE' ? 'WHOLE_VARIABLE_WEIGHT' as const : 'BUNCH' as const,
    price: 11000, priceQty: 1000, total: null };
  order.items = [item];
  const url = 'https://shop.example/staff/orders/6';
  const view = itemView(order, item, url);
  expect(view.text).toContain('1 кг');
  expect(view.text).not.toContain('1000 шт.');
  expect(buttons(view)).toContainEqual({ text: '⚖️ Открыть форму взвешивания', url: url + '?weigh=1#assembly', style: 'primary' });
  expect(buttons(view).some(button => button.callback_data?.match(/:(?:a|q|w):/))).toBe(false);
  expect(buttons(itemPage(order, 0)).some(button => button.callback_data?.match(/:(?:a|k)(?::|$)/))).toBe(false);
});

describe('seller actions and received customer decisions', () => {
  it('opens WAITING_SELLER issues directly and hides finish for both waiting statuses', () => {
    const order = fixture();
    order.customerName = 'Тест'; order.customerPhone = '+79990000000';
    order.items.forEach(item => { item.status = 'PICKED'; });
    order.issues = [{ id: 10, orderItemId: 4, replacementItemId: null, status: 'WAITING_SELLER', resolution: 'REQUEST_REDUCE' }] as OrderView['issues'];
    expect(dashboard(order).text).toContain('Нужно вам: 1');
    expect(buttons(dashboard(order)).some(button => button.callback_data === 's:6:f')).toBe(false);
    expect(buttons(issuePage(order))).toContainEqual({ text: '❗ Исправить: Виноград', callback_data: 's:6:v:4', style: 'primary' });
    expect(itemView(order, order.items[3]!).text).toContain('покупатель просит уменьшить вес');
    expect(buttons(itemView(order, order.items[3]!))).toContainEqual({ text: '⚖️ Исправить вес', callback_data: 's:6:r:4', style: 'primary' });
  });

  it('makes receipt correction a read-only transition and explains invalidating approval', () => {
    const order = fixture();
    Object.assign(order.items[3]!, { status: 'PICKED', actualQty: 524, actualTotal: 16768 });
    order.issues = [{ id: 10, orderItemId: 4, replacementItemId: null, status: 'RESOLVED', resolution: 'ACCEPT_ACTUAL', approvedActualQty: 524 }] as OrderView['issues'];
    expect(buttons(assemblyView(order, undefined, 4, 4))).toContainEqual({ text: '✏️ Исправить Виноград', callback_data: 's:6:v:4' });
    const view = itemView(order, order.items[3]!);
    expect(view.text).toContain('Покупатель согласовал фактическое количество: 524 г');
    expect(view.text).toContain('прежнее согласование перестанет действовать');
  });

  it('explains accepted replacements and never offers resetting the historical source', () => {
    const order = fixture();
    order.items[0]!.status = 'MISSING';
    order.issues = [{ id: 10, orderItemId: 1, replacementItemId: 2, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT', proposedName: 'Клубника' }] as OrderView['issues'];
    const source = itemView(order, order.items[0]!);
    expect(source.text).toContain('Покупатель принял замену: Клубника');
    expect(source.text).toContain('Исходная позиция остаётся в истории');
    expect(buttons(source).some(button => button.callback_data === 's:6:r:1')).toBe(false);
    expect(buttons(assemblyView(order, undefined, 1, 1)).some(button => button.text === '✏️ Исправить Киви')).toBe(false);
    expect(itemView(order, order.items[1]!).text).toContain('Соберите эту позицию как принятую замену');
  });

  it('includes a pending accepted replacement in seller work and opens the replacement instead of its historical source', () => {
    const order = fixture();
    order.items[0]!.status = 'MISSING';
    order.issues = [
      { id: 9, orderItemId: 4, replacementItemId: null, status: 'WAITING_CUSTOMER', resolution: null },
      { id: 10, orderItemId: 1, replacementItemId: 2, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT', proposedName: 'Клубника' },
      { id: 11, orderItemId: 3, replacementItemId: null, status: 'WAITING_SELLER', resolution: 'REQUEST_REDUCE' },
    ] as OrderView['issues'];
    const view = issuePage(order);
    expect(assemblyProgress(order)).toContain('Нужно вам: 2');
    expect(view.text).not.toContain('Клубника');
    expect(itemView(order, order.items[1]!).text).toContain('Соберите эту позицию как принятую замену');
    const actions = buttons(view);
    expect(actions).toContainEqual({ text: '✅ Замена одобрена: Клубника', callback_data: 's:6:v:2', style: 'primary' });
    expect(actions.some(button => button.callback_data === 's:6:v:1')).toBe(false);
    expect(actions.slice(0, 3).map(button => button.callback_data)).toEqual(['s:6:v:2', 's:6:v:3', 's:6:v:4']);
    expect(order.issues[1]!.status).toBe('RESOLVED');
  });

  it.each(['PICKED', 'MISSING'] as const)('removes the accepted replacement from actionable work after it becomes %s', status => {
    const order = fixture();
    order.items[0]!.status = 'MISSING';
    order.items[1]!.status = status;
    order.issues = [{ id: 10, orderItemId: 1, replacementItemId: 2, status: 'RESOLVED',
      resolution: 'ACCEPT_REPLACEMENT', proposedName: 'Клубника' }] as OrderView['issues'];
    expect(assemblyProgress(order)).toContain('Нужно вам: 0');
    expect(buttons(issuePage(order)).some(button => button.callback_data === 's:6:v:2')).toBe(false);
    expect(order.issues[0]!.resolution).toBe('ACCEPT_REPLACEMENT');
  });

  it('does not treat an unaccepted replacement or missing replacement item as accepted work', () => {
    const order = fixture();
    order.issues = [
      { id: 10, orderItemId: 1, replacementItemId: 2, status: 'WAITING_CUSTOMER', resolution: null },
      { id: 11, orderItemId: 3, replacementItemId: 99, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT' },
    ] as OrderView['issues'];
    expect(assemblyProgress(order)).toContain('Нужно вам: 0');
    const actions = buttons(issuePage(order));
    expect(actions.some(button => button.text.startsWith('✅ Замена одобрена'))).toBe(false);
    expect(actions).toContainEqual({ text: '⏳ Открыть: Киви', callback_data: 's:6:v:1' });
  });

  it('preserves a same-origin auth wrapper when linking to an exact weighing form', () => {
    expect(staffWeighUrl('https://shop.example/staff/orders/6?view=mobile', 4))
      .toBe('https://shop.example/staff/orders/6?view=mobile&weigh=4#assembly');
    const wrapped = staffWeighUrl('https://shop.example/login?method=telegram&returnTo=%2Fstaff%2Forders%2F6', 4)!;
    expect(new URL(wrapped).pathname).toBe('/login');
    expect(new URL(wrapped).searchParams.get('method')).toBe('telegram');
    expect(new URL(wrapped).searchParams.get('returnTo')).toBe('/staff/orders/6?weigh=4#assembly');
    expect(staffWeighUrl('https://shop.example/login?returnTo=https://evil.example/staff/orders/6', 4)).toBeUndefined();
    expect(staffWeighUrl('http://shop.example/staff/orders/6', 4)).toBeUndefined();
    expect(staffWeighUrl('https://shop.example/staff/orders/6', 0)).toBeUndefined();
  });

  it('does not attribute a seller reset to a buyer and prioritizes a replacement item own question', () => {
    const order = fixture();
    order.issues = [
      { id: 10, orderItemId: 1, replacementItemId: 4, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT', proposedName: 'Виноград' },
      { id: 11, orderItemId: 4, replacementItemId: null, status: 'WAITING_SELLER', resolution: null },
    ] as OrderView['issues'];
    const screen = itemView(order, order.items[3]!);
    expect(screen.text).toContain('позиция возвращена в сборку');
    expect(screen.text).toContain('Сохраните новое фактическое количество');
    expect(screen.text).not.toContain('покупатель просит');
  });
});

describe('sequential assembly', () => {
  it('starts after the saved item, wraps and skips processed items and waiting decisions', () => {
    const order = fixture();
    order.issues = [{ orderItemId: 3, replacementItemId: null, status: 'WAITING_CUSTOMER' }] as OrderView['issues'];
    expect(nextAssemblyItem(order, 2)?.id).toBe(4);
    expect(nextAssemblyItem(order, 4)?.id).toBe(1);
    order.status = 'READY';
    expect(nextAssemblyItem(order)).toBeUndefined();
  });

  it('keeps exact weighed quantities and server amounts beside the next item', () => {
    const order = fixture();
    const item = order.items[3]!;
    Object.assign(item, { qty: 500, actualQty: 524, total: 16000, actualTotal: 16768, status: 'PICKED' });
    const screen = assemblyView(order, undefined, item.id, item.id);
    expect(screen.text).toContain('✅ Сохранено: Виноград');
    expect(screen.text).toContain('Заказано: 500 г → собрано: 524 г');
    expect(screen.text).toContain('Сумма: 167,68 ₽');
    expect(screen.text).toContain('Изменение веса: +24 г');
    expect(screen.text).toContain('Изменение суммы: +7,68 ₽');
    expect(screen.text).toContain('Собрано: 2/6 · осталось: 3');
    expect(screen.text).toContain('Нет в наличии: 1 · ждём ответа: 0');
    expect(screen.text).toContain('Киви');
  });

  it('offers skipping without changing any item and blocks the finish shortcut while waiting', () => {
    const order = fixture();
    expect(buttons(itemView(order, order.items[0]!))).toContainEqual({
      text: 'Пропустить →', callback_data: 's:6:v:2',
    });
    order.customerName = 'Тест'; order.customerPhone = '+79990000000';
    order.items.forEach(item => { item.status = 'PICKED'; });
    order.issues = [{ orderItemId: 1, status: 'WAITING_CUSTOMER' }] as OrderView['issues'];
    const screen = assemblyView(order);
    expect(screen.text).toContain('ждём ответа: 1');
    expect(buttons(screen).some(button => button.callback_data === 's:6:f')).toBe(false);
  });
});


function premiumFixture(): OrderView {
  const order = fixture();
  Object.assign(order, { type: 'PICKUP', customerName: 'Анна', customerPhone: '+79990000000',
    comment: 'Спелые продукты, пожалуйста', subtotal: 125000, deliveryPrice: 0, total: 125000,
    finalSubtotal: null, finalTotal: null, assemblyFinalizedAt: null, payment: null, delivery: null });
  for (const item of order.items) Object.assign(item, { price: 32000, priceQty: item.unit === 'GRAM' ? 1000 : 1,
    total: 16000, actualTotal: item.status === 'PICKED' ? 16000 : item.status === 'MISSING' ? 0 : null });
  Object.assign(order.items[3]!, { status: 'PICKED', actualQty: 524, actualTotal: 16768 });
  order.issues = [{ id: 10, orderItemId: 4, status: 'WAITING_SELLER', resolution: 'REQUEST_REDUCE',
    replacementItemId: null }] as OrderView['issues'];
  return order;
}

describe('STAFF clear actions, reviews and bounded pages', () => {
  it('distinguishes requested quantities from confirmed actual weight and cost in Rich item details', () => {
    const order = premiumFixture();
    const data = JSON.stringify(richMessage(dashboard(order)));
    expect(data).toContain('Виноград\\nЗаказано: 500 г · собран\\nСобрано: 524 г\\nФактически за товар: 167,68 ₽');
    Object.assign(order.items[3]!, { unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT',
      qty: 2, actualQty: 2, actualWeightGrams: 1500, actualTotal: 48000 });
    const whole = JSON.stringify(richMessage(dashboard(order)));
    expect(whole).toContain('Заказано: 2 шт. · собран\\nСобрано: 2 шт.\\nФактический вес: 1,5 кг\\nФактически за товар: 480 ₽');
    Object.assign(order.items[3]!, { status: 'MISSING', actualQty: 0, actualTotal: 0 });
    const missing = JSON.stringify(richMessage(dashboard(order)));
    expect(missing).not.toContain('Фактический вес: 1,5 кг');
    expect(missing).not.toContain('Фактически за товар: 0 ₽');
  });
  it('prioritizes a received buyer correction over unrelated pending goods', () => {
    expect(nextStaffAction(premiumFixture())).toBe('Далее: исправьте Виноград.');
    const order = premiumFixture();
    order.items[0]!.status = 'MISSING';
    order.issues = [{ id: 10, orderItemId: 1, replacementItemId: 2, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT' }] as OrderView['issues'];
    expect(buttons(dashboard(order)).some(button => button.callback_data === 's:6:j')).toBe(true);
  });
  it('shows the consequence of resetting a saved item and binds confirmation to its session', () => {
    const order = premiumFixture();
    const view = reviewView(order, 'RESET_ITEM', {}, '0123456789abcdef', 4);
    expect(view.text).toContain('524 г · 167,68 ₽');
    expect(view.text).toContain('Прежнее согласование покупателя перестанет действовать');
    expect(buttons(view)).toContainEqual({ text: '↩️ Вернуть позицию в сборку', callback_data: 's:6:ry:0123456789abcdef', style: 'danger' });
  });
  it('does not offer a destructive confirmation for a historical replaced item', () => {
    const order = premiumFixture(); order.items[0]!.status = 'MISSING';
    order.issues = [{ id: 10, orderItemId: 1, replacementItemId: 2, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT' }] as OrderView['issues'];
    const view = reviewView(order, 'RESET_ITEM', {}, '0123456789abcdef', 1);
    expect(canReview(order, 'RESET_ITEM', 1)).toBe(false);
    expect(buttons(view).some(button => button.callback_data?.includes(':ry:'))).toBe(false);
  });
  it('shows the actual payable goods amount and payment method instead of an estimated checkout total', () => {
    const order = premiumFixture(); order.status = 'READY'; order.finalTotal = 99999;
    order.assemblyFinalizedAt = new Date();
    order.payment = { status: 'REPORTED', amount: 44520, method: 'SBP' } as OrderView['payment'];
    const view = reviewView(order, 'PAYMENT', {}, '0123456789abcdef');
    expect(view.text).toContain('К оплате магазину: 445,2 ₽');
    expect(view.text).toContain('Способ, указанный покупателем: СБП');
    expect(view.text).toContain('Проверьте фактическое поступление всей суммы');
    expect(view.text).not.toContain('999,99');
    expect(buttons(view).some(button => button.callback_data?.includes(':py:'))).toBe(true);
  });
  it('does not promise a final price before server finalization and links to the full goods review', () => {
    const order = premiumFixture(); order.issues = []; order.items.forEach(item => { item.status = 'PICKED'; });
    const view = reviewView(order, 'FINISH_ASSEMBLY', {}, '0123456789abcdef');
    expect(view.text).toContain('сумма к оплате появятся после завершения сборки');
    expect(buttons(view)).toContainEqual({ text: '🧺 Проверить позиции', callback_data: 's:6:i' });
    expect(buttons(view).some(button => button.callback_data?.includes(':fy:'))).toBe(true);
  });
  it('clamps stale pages and keeps extra positions accessible beyond the first ten', () => {
    const order = premiumFixture();
    expect(itemPage(order, 10000).text).toContain('позиции 1–6 из 6');
    order.extras = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, title: 'Доп. позиция ' + (i + 1),
      status: 'ACTIVE', version: 1, quantity: 1, unitPrice: 100, amount: 100 })) as OrderView['extras'];
    expect(buttons(extraPage(order))).toContainEqual({ text: 'Следующие →', callback_data: 's:6:xl:10' });
    const last = extraPage(order, 10000);
    expect(last.text).not.toContain('Доп. позиция 23');
    expect(buttons(last).some(button => button.text.includes('Доп. позиция 23 · 1 × 1 ₽ = 1 ₽'))).toBe(true);
    expect(buttons(last)).toContainEqual({ text: '← Предыдущие', callback_data: 's:6:xl:10' });
    expect(buttons(last).some(button => button.callback_data === 's:6:xl:30')).toBe(false);
  });
  it('returns from a later item to the same page of the item list', () => {
    const order = premiumFixture();
    order.items = Array.from({ length: 19 }, (_, i) => ({ ...order.items[0]!, id: i + 1 }));
    expect(buttons(itemView(order, order.items[18]!))).toContainEqual({ text: '⬅️ К позициям', callback_data: 's:6:i:16' });
  });
  it('keeps all representative screens and callback data within Telegram limits', () => {
    const order = premiumFixture();
    const ready = structuredClone(order); ready.status = 'READY'; ready.assemblyFinalizedAt = new Date();
    ready.finalTotal = 44520; ready.payment = { status: 'REPORTED', amount: 44520, method: 'SBP' } as OrderView['payment'];
    const complete = structuredClone(order); complete.issues = []; complete.items.forEach(item => { item.status = 'PICKED'; });
    const screens = [
      { id: 'seller-work', title: 'Рабочий обзор продавца', ...workOverview({ new: 3, confirmed: 2, assembly: 4, ready: 2, delivery: 1, seller: 2, customer: 3 }) },
      { id: 'seller-dashboard', title: 'Заказ в сборке: что делать дальше', ...dashboard(order, 'https://korzinamarket.example/staff/orders/6') },
      { id: 'seller-issue', title: 'Получен ответ покупателя', ...issuePage(order) },
      { id: 'seller-item', title: 'Позиция: фактический вес и решение покупателя', ...itemView(order, order.items[3]!, 'https://korzinamarket.example/staff/orders/6') },
      { id: 'seller-reset', title: 'Безопасное исправление веса', ...reviewView(order, 'RESET_ITEM', {}, '0123456789abcdef', 4) },
      { id: 'seller-finish', title: 'Проверка заказа перед завершением сборки', ...reviewView(complete, 'FINISH_ASSEMBLY', {}, '0123456789abcdef') },
      { id: 'seller-payment', title: 'Получение оплаты: проверка суммы и способа', ...reviewView(ready, 'PAYMENT', {}, '0123456789abcdef') },
      { id: 'seller-help', title: 'Справка и быстрое открытие заказа', ...staffHelp() },
    ];
    for (const screen of screens) {
      expect(screen.text.length).toBeLessThanOrEqual(3900);
      for (const button of buttons(screen)) if (button.callback_data) expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
    if (process.env.TELEGRAM_PREMIUM_SNAPSHOTS === '1')
      writeFileSync(resolve('../../work/telegram-premium/seller-screens.json'), JSON.stringify(screens, null, 2) + '\n');
  });
});
