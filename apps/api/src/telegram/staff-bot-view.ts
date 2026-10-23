import { variableWeight, priceUnit } from '../product/sale.js';
import { formatAddress } from '../common/address.js';
import type { StaffService } from '../staff/staff.service.js';
import { reviewCallback, type FlowPayload, type ReviewFlow } from './staff-flow.js';
import { clean, money, quantity, staffConfirmData, staffData, staffQueueData } from './staff-bot.js';
import { orderChatPath } from './chat-notice.js';
import { orderRich, orderFallback, paymentLabel, progressLabel } from './order-rich.js';
import type { TelegramScreen } from './rich.js';

export type OrderView = Awaited<ReturnType<StaffService['get']>>;
export type Button = ({ text: string; callback_data: string } | { text: string; url: string } |
  { text: string; copy_text: { text: string } }) &
  { style?: 'primary' | 'success' | 'danger' };
export type Keyboard = { inline_keyboard: Button[][] };
export const activeStatuses = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'] as const;
export const statusText = {
  NEW: 'Новый', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Собирается',
  READY: 'Готов', DELIVERING: 'Доставляется', COMPLETED: 'Завершён', CANCELED: 'Отменён',
} as const;
const deliveryText = { PENDING: 'ожидается', ASSIGNED: 'назначена',
  PICKED_UP: 'у курьера', DELIVERED: 'доставлена', CANCELED: 'отменена' } as const;
const itemStatusText = { PENDING: 'в сборке', PICKED: 'собран', MISSING: 'нет в наличии' } as const;
const waitingStatuses = ['WAITING_CUSTOMER', 'WAITING_SELLER'];

export function staffWeighUrl(url: string, itemId: number): string | undefined {
  if (!Number.isSafeInteger(itemId) || itemId < 1 || itemId > 2147483647) return undefined;
  try {
    const outer = new URL(url);
    if (outer.protocol !== 'https:' || outer.username || outer.password) return undefined;
    const returnTo = outer.searchParams.get('returnTo');
    const target = returnTo === null ? outer : new URL(returnTo, outer.origin);
    if (target.origin !== outer.origin || !/^\/staff\/orders\/[1-9]\d{0,9}$/.test(target.pathname)) return undefined;
    target.searchParams.set('weigh', String(itemId));
    target.hash = 'assembly';
    if (returnTo !== null) outer.searchParams.set('returnTo', target.pathname + target.search + target.hash);
    return outer.href;
  } catch { return undefined; }
}

function relatedIssue(order: OrderView, itemId: number) {
  return order.issues.find(issue => issue.orderItemId === itemId) ??
    order.issues.find(issue => issue.replacementItemId === itemId);
}
function sellerIssueItem(order: OrderView, issue: OrderView['issues'][number]) {
  if (issue.status === 'WAITING_SELLER') return order.items.find(item => item.id === issue.orderItemId);
  if (issue.status === 'RESOLVED' && issue.resolution === 'ACCEPT_REPLACEMENT')
    return order.items.find(item => item.id === issue.replacementItemId && item.status === 'PENDING');
  return undefined;
}
export function canReset(order: OrderView, item: OrderView['items'][number]): boolean {
  const issue = relatedIssue(order, item.id);
  return order.status === 'ASSEMBLING' && ['PICKED', 'MISSING'].includes(item.status) &&
    !(issue?.orderItemId === item.id && (issue.replacementItemId != null ||
      (issue.status === 'RESOLVED' && issue.resolution === 'REMOVE_ITEM')));
}
function issueText(order: OrderView, item: OrderView['items'][number]): string[] {
  const issue = relatedIssue(order, item.id);
  if (!issue) return [];
  if (issue.status === 'WAITING_SELLER') return [issue.resolution === 'REQUEST_REDUCE'
    ? variableWeight(item) ? '❗ Нужно вам: покупатель просит подобрать другой экземпляр.'
      : '❗ Нужно вам: покупатель просит уменьшить вес.'
    : '❗ Нужно вам: позиция возвращена в сборку.',
    item.status === 'PENDING' ? 'Сохраните новое фактическое количество.' : 'Верните позицию в сборку и сохраните новый фактический вес.'];
  if (issue.status === 'WAITING_CUSTOMER') {
    const since = issue.updatedAt instanceof Date ? issue.updatedAt.getTime() : NaN;
    const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((Date.now() - since) / 60000)) : null;
    return ['⏳ Ждём решения покупателя' + (minutes === null ? '.' : ' · ' + minutes + ' мин.'),
      ...(issue.type === 'REPLACEMENT' && issue.proposedName ? ['Предложена замена: ' + clean(issue.proposedName, 100)] : [])];
  }
  if (issue.resolution === 'ACCEPT_ACTUAL') return ['✅ Покупатель согласовал фактическое количество: ' +
    quantity(issue.approvedActualQty ?? issue.actualQty ?? item.actualQty ?? item.qty, item.unit) +
    (issue.approvedWeightGrams != null ? ' · ' + quantity(issue.approvedWeightGrams, 'GRAM') : '')];
  if (issue.resolution === 'ACCEPT_REPLACEMENT') return ['✅ Покупатель принял замену: ' + clean(issue.proposedName ?? item.productName, 100),
    issue.replacementItemId === item.id ? item.status === 'PICKED' ? 'Принятая замена собрана.' : 'Соберите эту позицию как принятую замену.' : 'Исходная позиция остаётся в истории. Собирайте принятую замену.'];
  if (issue.resolution === 'REMOVE_ITEM') return ['Покупатель убрал исходный товар. Он остаётся в истории заказа.'];
  return [];
}

export function issuePage(order: OrderView, offset = 0): { text: string; keyboard: Keyboard } {
  const issues = order.issues.filter(issue => waitingStatuses.includes(issue.status) || sellerIssueItem(order, issue))
    .sort((a, b) => Number(Boolean(sellerIssueItem(order, b))) - Number(Boolean(sellerIssueItem(order, a))) || a.id - b.id);
  offset = Math.min(offset, Math.max(0, Math.floor((issues.length - 1) / 5) * 5));
  const visible = issues.slice(offset, offset + 5);
  const lines = ['Заказ #' + order.id + ' · вопросы и ответы', assemblyProgress(order)];
  const rows: Button[][] = [];
  for (const issue of visible) {
    const item = sellerIssueItem(order, issue) ?? order.items.find(value => value.id === issue.orderItemId);
    if (!item) continue;
    lines.push('', clean(item.productName, 100), ...issueText(order, item));
    const label = issue.status === 'WAITING_SELLER' ? '❗ Исправить: '
      : issue.resolution === 'ACCEPT_REPLACEMENT' ? '✅ Замена одобрена: ' : '⏳ Открыть: ';
    rows.push([{ text: label + clean(item.productName, 35),
      callback_data: staffData(order.id, 'v', item.id) }]);
  }
  if (!visible.length) lines.push('', 'Нерешённых вопросов нет. Согласованные изменения показаны в карточках товаров.');
  const nav: Button[] = [];
  if (offset > 0) nav.push({ text: '← Вопросы', callback_data: staffData(order.id, 'j', Math.max(0, offset - 5)) });
  if (offset + 5 < issues.length) nav.push({ text: 'Вопросы →', callback_data: staffData(order.id, 'j', offset + 5) });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '← К заказу', callback_data: staffData(order.id, 'o') }],
    [{ text: 'Рабочая очередь', callback_data: staffQueueData('seller') }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function nextAssemblyItem(order: OrderView, afterItemId?: number): OrderView['items'][number] | undefined {
  if (order.status !== 'ASSEMBLING') return undefined;
  const start = order.items.findIndex(item => item.id === afterItemId);
  const ordered = [...order.items.slice(start + 1), ...order.items.slice(0, start + 1)];
  return ordered.find(item => item.status === 'PENDING' && !order.issues.some(issue =>
    issue.status === 'WAITING_CUSTOMER' &&
    (issue.orderItemId === item.id || issue.replacementItemId === item.id)));
}

export function assemblyProgress(order: OrderView): string {
  const picked = order.items.filter(item => item.status === 'PICKED').length;
  const missing = order.items.filter(item => item.status === 'MISSING').length;
  const pending = order.items.filter(item => item.status === 'PENDING').length;
  const waiting = order.issues.filter(issue => issue.status === 'WAITING_CUSTOMER').length;
  const needed = order.issues.filter(issue => sellerIssueItem(order, issue)).length;
  return 'Собрано: ' + picked + '/' + order.items.length + ' · осталось: ' + pending +
    '\nНет в наличии: ' + missing + ' · ждём ответа: ' + waiting + '\nНужно вам: ' + needed;
}

function itemResult(order: OrderView, itemId: number): string {
  const item = order.items.find(value => value.id === itemId);
  if (!item || item.status === 'PENDING') return '';
  const lines = [(item.status === 'MISSING' ? '❌ Нет в наличии: ' : '✅ Сохранено: ') + clean(item.productName, 100)];
  if (item.status === 'PICKED' && item.actualQty != null) {
    lines.push('Заказано: ' + quantity(item.qty, item.unit) + ' → собрано: ' + quantity(item.actualQty, item.unit));
    if (variableWeight(item) && item.actualWeightGrams != null)
      lines.push('Фактический вес: ' + quantity(item.actualWeightGrams, 'GRAM'));
    if (item.actualTotal != null) lines.push('Сумма: ' + money(item.actualTotal));
    if (item.unit === 'GRAM') {
      const delta = item.actualQty - item.qty;
      lines.push('Изменение веса: ' + (delta > 0 ? '+' : delta < 0 ? '−' : '') + quantity(Math.abs(delta), 'GRAM'));
    }
    if (item.total != null && item.actualTotal != null) {
      const delta = item.actualTotal - item.total;
      lines.push('Изменение суммы: ' + (delta > 0 ? '+' : delta < 0 ? '−' : '') + money(Math.abs(delta)));
    }
  }
  if (order.issues.some(issue => issue.orderItemId === item.id && issue.status === 'WAITING_CUSTOMER'))
    lines.push('❗ Требуется решение покупателя. Остальные позиции можно собирать.');
  return lines.join('\n');
}

export function assemblyView(order: OrderView, url?: string, afterItemId?: number, savedItemId?: number):
  { text: string; keyboard: Keyboard } {
  const next = nextAssemblyItem(order, afterItemId);
  const view = next ? itemView(order, next, url) : dashboard(order, url);
  const saved = savedItemId === undefined ? '' : itemResult(order, savedItemId);
  const item = savedItemId === undefined ? undefined : order.items.find(value => value.id === savedItemId);
  if (saved && item && canReset(order, item)) view.keyboard.inline_keyboard.unshift([{
    text: '✏️ Исправить ' + clean(item.productName, 32), callback_data: staffData(order.id, 'v', item.id),
  }]);
  return { ...view, text: saved ? saved + '\n\n' + view.text : view.text };
}

export function canQuickConfirm(order: OrderView, item: OrderView['items'][number]): boolean {
  return order.status === 'ASSEMBLING' && item.status === 'PENDING' &&
    (item.unit === 'PIECE' || item.unit === 'PACK' || item.unit === 'BUNCH') && !variableWeight(item) &&
    !order.issues.some(issue => issue.orderItemId === item.id || issue.replacementItemId === item.id);
}


export function nextStaffAction(order: OrderView): string {
  if (order.status === 'NEW') return 'Далее: проверьте заказ и подтвердите приём.';
  if (order.status === 'CONFIRMED') return 'Далее: начните сборку.';
  if (order.status === 'ASSEMBLING') {
    const issue = order.issues.find(value => sellerIssueItem(order, value));
    const item = issue && sellerIssueItem(order, issue);
    if (item) return 'Далее: ' + (issue.status === 'WAITING_SELLER' ? 'исправьте ' : 'соберите принятую замену ') + clean(item.productName, 80) + '.';
    const next = nextAssemblyItem(order);
    if (next) return 'Далее: соберите ' + clean(next.productName, 80) + '.';
    if (order.issues.some(value => value.status === 'WAITING_CUSTOMER')) return 'Далее: дождитесь решения покупателя. Завершение сборки пока недоступно.';
    if (!order.items.some(item => item.status === 'PICKED') && !order.extras.some(extra => extra.status === 'ACTIVE'))
      return 'Далее: все товары отсутствуют. Верните доступные товары в сборку или отмените заказ.';
    return 'Далее: проверьте результат сборки и завершите её.';
  }
  if (order.status === 'READY') {
    if (order.payment?.status === 'REPORTED') return 'Далее: проверьте поступление денег и подтвердите оплату.';
    if (order.payment?.status !== 'PAID') return 'Далее: дождитесь оплаты. Подтверждайте её после проверки поступления.';
    if (order.type === 'PICKUP') return 'Далее: выдайте оплаченный заказ покупателю.';
    if (order.delivery?.provider === 'YANDEX') return 'Далее: проверьте доставку Яндекс на сайте.';
    return order.delivery?.status === 'ASSIGNED' ? 'Далее: передайте заказ назначенному курьеру.' : 'Далее: оформите доставку и назначьте курьера.';
  }
  if (order.status === 'DELIVERING') return order.delivery?.provider === 'OTHER'
    ? 'Далее: подтвердите доставку после вручения покупателю.' : 'Далее: следите за статусом доставки на сайте.';
  return order.status === 'COMPLETED' ? 'Заказ выполнен. Данные сохранены в истории.' : 'Заказ отменён. Данные сохранены в истории.';
}

export function canReview(order: OrderView, action: ReviewFlow, itemId?: number | null, data: FlowPayload = {}): boolean {
  if (action === 'PAYMENT') return order.status === 'READY' && Boolean(order.assemblyFinalizedAt) &&
    ['AWAITING', 'REPORTED'].includes(order.payment?.status ?? '') &&
    Number.isSafeInteger(order.payment?.amount) && (order.payment?.amount ?? 0) > 0;
  if (action === 'REOPEN') return order.status === 'READY' &&
    ['AWAITING', 'CANCELED'].includes(order.payment?.status ?? '') &&
    !order.delivery?.externalOrderId && order.delivery?.provider !== 'OTHER';
  if (order.status !== 'ASSEMBLING' || order.assemblyFinalizedAt ||
    ['REPORTED', 'PAID'].includes(order.payment?.status ?? '')) return false;
  if (action === 'RESET_ITEM') {
    const item = order.items.find(value => value.id === itemId);
    return Boolean(item && canReset(order, item));
  }
  if (action === 'REMOVE_EXTRA') return order.extras.some(extra =>
    extra.id === data.extraId && extra.status === 'ACTIVE' && extra.version === data.version);
  return order.items.length > 0 && order.items.every(item => item.status !== 'PENDING') &&
    !order.issues.some(issue => waitingStatuses.includes(issue.status)) &&
    (order.items.some(item => item.status === 'PICKED') || order.extras.some(extra => extra.status === 'ACTIVE'));
}

export function reviewView(order: OrderView, action: ReviewFlow, data: FlowPayload, code: string, itemId?: number | null):
  { text: string; keyboard: Keyboard } {
  const lines = ['Заказ #' + order.id + ' · проверка перед действием'];
  const rows: Button[][] = [];
  const item = order.items.find(value => value.id === itemId);
  if (action === 'PAYMENT') {
    const methods = { SBP: 'СБП', QR: 'QR-код', CARD_TRANSFER: 'перевод на карту' };
    lines.push('Подтвердить получение оплаты?', clean(order.customerName, 100),
      'К оплате магазину: ' + money(order.payment?.amount),
      'Способ, указанный покупателем: ' + (order.payment?.method ? methods[order.payment.method] : 'не указан'),
      order.payment?.status === 'REPORTED' ? 'Покупатель сообщил об оплате. Это сообщение не подтверждает поступление денег.' : 'Покупатель ещё не сообщил об оплате.',
      'Проверьте фактическое поступление всей суммы на счёт магазина. Кнопка отметит платёж полученным и откроет выдачу или доставку.');
  } else if (action === 'RESET_ITEM') {
    lines.push('Вернуть позицию в сборку?', clean(item?.productName, 120));
    if (item?.actualQty != null) lines.push('Сохранено: ' + quantity(item.actualQty, item.unit) +
      (item.actualTotal != null ? ' · ' + money(item.actualTotal) : ''));
    lines.push('Фактическое количество и сумма будут очищены. Прежнее согласование покупателя перестанет действовать. Потребуется новый результат сборки.');
  } else if (action === 'REMOVE_EXTRA') {
    const extra = order.extras.find(value => value.id === data.extraId);
    lines.push('Убрать дополнительную позицию?', clean(extra?.title, 120), 'Сумма позиции: ' + money(extra?.amount),
      'Позиция будет отменена и останется в истории. Итог заказа будет пересчитан при завершении сборки.');
  } else if (action === 'REOPEN') {
    lines.push('Вернуть заказ к сборке?', 'Текущая сумма заказа: ' + money(order.finalTotal),
      'Платёж будет отменён. После исправлений потребуется завершить сборку и получить новую сумму к оплате.');
  } else {
    lines.push('Завершить сборку?', clean(order.customerName, 100) + ' · ' +
      (order.type === 'PICKUP' ? 'самовывоз' : 'доставка'), assemblyProgress(order));
    for (const value of order.items.slice(0, 8)) lines.push(
      (value.status === 'MISSING' ? '❌ ' : value.status === 'PENDING' ? '⬜ ' : '✅ ') + clean(value.productName, 70) +
      ' · ' + quantity(value.actualQty ?? value.qty, value.unit) +
      (value.actualWeightGrams != null && variableWeight(value) ? ' · ' + quantity(value.actualWeightGrams, 'GRAM') : '') +
      ' · ' + money(value.actualTotal));
    if (order.items.length > 8) lines.push('Ещё позиций: ' + (order.items.length - 8) + '. Полный список — в позициях заказа.');
    const extras = order.extras.filter(extra => extra.status === 'ACTIVE');
    if (extras.length) lines.push('Доп. позиции: ' + extras.length + '. Проверьте их в заказе.');
    lines.push('Окончательная скидка, доставка и сумма к оплате появятся после завершения сборки. Покупатель получит результат сборки.');
    rows.push([{ text: '🧺 Проверить позиции', callback_data: staffData(order.id, 'i') }]);
    if (extras.length) rows.push([{ text: '📋 Проверить доп. позиции', callback_data: staffData(order.id, 'xl') }]);
  }
  if (canReview(order, action, itemId, data)) rows.unshift([{
    text: { FINISH_ASSEMBLY: '✅ Завершить сборку', PAYMENT: '💳 Да, деньги поступили',
      RESET_ITEM: '↩️ Вернуть позицию в сборку', REMOVE_EXTRA: '❌ Убрать доп. позицию', REOPEN: '↩️ Вернуть заказ к сборке' }[action],
    callback_data: staffConfirmData(order.id, reviewCallback[action], code),
    style: action === 'FINISH_ASSEMBLY' || action === 'PAYMENT' ? 'success' : 'danger',
  }]);
  else lines.push('⚠️ Заказ изменился: действие сейчас недоступно. Вернитесь к заказу и проверьте его состояние.');
  rows.push([{ text: '← К заказу без изменений', callback_data: staffData(order.id, 'zb') }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function staffHelp(): { text: string; keyboard: Keyboard } {
  return { text: ['Рабочий чат KorzinaMarket',
    '/work — обзор работы и быстрые очереди', '/orders — все активные заказы',
    '/attention — вопросы, требующие вашего действия', '/waiting — решения покупателей',
    '/order 123 или #123 — открыть заказ по номеру',
    '/resume — продолжить незавершённый ввод', '/cancel — отменить только ввод',
    'Отвечайте на сообщение с запросом веса или данных. Перед завершением сборки появится проверка, после неё — итоговая сумма.',
  ].join('\n'), keyboard: { inline_keyboard: [[{ text: 'Рабочий обзор', callback_data: 'sw' }],
    [{ text: 'Все заказы', callback_data: staffQueueData('all') }]] } };
}

export function workOverview(counts: Record<'new' | 'confirmed' | 'assembly' | 'ready' | 'delivery' | 'seller' | 'customer', number>):
  { text: string; keyboard: Keyboard } {
  return { text: ['Рабочий обзор KorzinaMarket',
    'Новые: ' + counts.new + ' · подтверждены: ' + counts.confirmed,
    'В сборке: ' + counts.assembly + ' · готовы: ' + counts.ready + ' · доставляются: ' + counts.delivery,
    'Нужно вам: ' + counts.seller + ' · ждём покупателя: ' + counts.customer,
    'Вопросы покупателей — в первую очередь. /order 123 — открыть заказ.',
  ].join('\n'), keyboard: { inline_keyboard: [
    [{ text: '❗ Нужно вам · ' + counts.seller, callback_data: staffQueueData('seller'), ...(counts.seller ? { style: 'primary' as const } : {}) }],
    [{ text: '🆕 Новые · ' + counts.new, callback_data: staffQueueData('new') },
      { text: '🧺 В работе · ' + (counts.confirmed + counts.assembly), callback_data: staffQueueData('assembly') }],
    [{ text: '✅ Готовы · ' + counts.ready, callback_data: staffQueueData('ready') },
      { text: '🚚 Доставляются · ' + counts.delivery, callback_data: staffQueueData('delivery') }],
    [{ text: '⏳ Ждём покупателя · ' + counts.customer, callback_data: staffQueueData('customer') }],
    [{ text: 'Все активные заказы', callback_data: staffQueueData('all') }],
    [{ text: '🔄 Обновить', callback_data: 'sw' }, { text: 'Помощь', callback_data: 'sh' }],
  ] } };
}

export function dashboard(order: OrderView, url?: string): TelegramScreen & { keyboard: Keyboard } {
  const id = order.id;
  const lines = [
    'Заказ #' + id + ' · ' + statusText[order.status],
    clean(order.customerName, 100) + ' · ' + clean(order.customerPhone, 40),
    order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка',
  ];
  if (order.type === 'DELIVERY')
    lines.push(clean(formatAddress(order), 200));
  lines.push(nextStaffAction(order));
  if (order.comment) lines.push('Комментарий: ' + clean(order.comment, 300));
  lines.push('Товары: ' + money(order.subtotal), 'Доставка: ' + money(order.deliveryPrice),
    'Запрошено: ' + money(order.total));
  if (order.finalSubtotal !== null)
    lines.push('Факт товаров: ' + money(order.finalSubtotal), 'Итого: ' + money(order.finalTotal));
  if (order.promoCodeSnapshot) lines.push('Промокод: ' + clean(order.promoCodeSnapshot, 32) +
    ' · скидка ' + money(order.finalPromoDiscount ?? order.promoDiscount));
  lines.push(paymentLabel(order.payment), progressLabel(order));
  if (order.payment) lines.push((order.payment.status === 'PAID' ? 'Подтверждено за товары: ' : 'Сумма платежа за товары: ') + money(order.payment.amount));
  if (order.payment?.status === 'REPORTED') lines.push('⚠️ Покупатель сообщил об оплате. Проверьте поступление денег.');
  if (order.delivery) lines.push('Доставка: ' +
    (order.delivery.provider === 'YANDEX' ? 'Яндекс' : 'другой курьер') + ' · ' +
    deliveryText[order.delivery.status]);
  lines.push('Осталось: ' + order.items.filter(item => item.status === 'PENDING').length, ...assemblyProgress(order).split('\n').slice(1));
  for (const item of order.items.slice(0, 5)) lines.push('• ' + clean(item.productName, 65) +
    ' — ' + quantity(item.qty, item.unit) + ' · ' + itemStatusText[item.status]);
  if (order.items.length > 5) lines.push('Ещё позиций: ' + (order.items.length - 5));
  if (order.extras.some(extra => extra.status === 'ACTIVE'))
    lines.push('Доп. позиции: ' + order.extras.filter(extra => extra.status === 'ACTIVE').length);

  const rows: Button[][] = [];
  const add = (text: string, action: Parameters<typeof staffData>[1]) =>
    rows.push([{ text, callback_data: staffData(id, action) }]);
  if (order.status === 'NEW') rows.push([{ text: '✅ Подтвердить', callback_data: 'order:' + id + ':confirm' }]);
  if (order.status === 'CONFIRMED')
    rows.push([{ text: '▶️ Начать сборку', callback_data: 'order:' + id + ':assembly' }]);
  if (order.status === 'ASSEMBLING') {
    const waiting = order.issues.filter(issue => waitingStatuses.includes(issue.status) || sellerIssueItem(order, issue));
    const urgent = waiting.find(issue => sellerIssueItem(order, issue));
    const urgentItem = urgent && sellerIssueItem(order, urgent);
    if (urgentItem) rows.push([{ text: (urgent.status === 'WAITING_SELLER' ? '❗ Исправить: ' : '✅ Собрать замену: ') +
      clean(urgentItem.productName, 40), callback_data: staffData(id, 'v', urgentItem.id), style: 'primary' }]);
    if (waiting.length) add('❗ Вопросы и ответы · ' + waiting.length, 'j');
    const next = nextAssemblyItem(order);
    if (next) rows.push([{ text: '▶️ Продолжить сборку', callback_data: staffData(id, 'v', next.id) }]);
    add('🧺 Позиции', 'i');
    if (order.items.some(item => canQuickConfirm(order, item)))
      add('✅ Подтвердить все штучные', 'k');
    add('➕ Доп. позиция / услуга', 'x');
    if (order.extras.some(extra => extra.status === 'ACTIVE')) add('📋 Доп. позиции', 'xl');
    if (canReview(order, 'FINISH_ASSEMBLY'))
      add('✅ Проверить и завершить сборку', 'f');
  }
  if (order.status === 'READY') {
    if (['AWAITING', 'REPORTED'].includes(order.payment?.status ?? '')) add('💳 Оплата получена', 'p');
    if (order.payment?.status === 'PAID' && order.type === 'PICKUP') add('✅ Заказ выдан', 'u');
    if (order.payment?.status === 'PAID' && order.type === 'DELIVERY' &&
      order.delivery?.provider !== 'YANDEX') {
      if (order.delivery?.status === 'ASSIGNED') add('🚚 Передать курьеру', 'h');
      else add('🚚 Оформить доставку', 'd');
    }
    if (['AWAITING', 'CANCELED'].includes(order.payment?.status ?? '') &&
      !order.delivery?.externalOrderId && order.delivery?.provider !== 'OTHER')
      add('↩️ Вернуть к сборке', 'b');
  }
  if (order.status === 'DELIVERING' && order.delivery?.provider === 'OTHER')
    add('✅ Доставлен', 'c');
  if (!['COMPLETED', 'CANCELED'].includes(order.status)) add('❌ Отменить заказ', 'z');
  rows.push([{ text: '← Рабочая очередь', callback_data: staffQueueData('all') }]);
  add('🔄 Обновить', 'o');
  if (url) {
    rows.push([{ text: 'Чат с покупателем', url: new URL(orderChatPath(id, true), url).href }]);
    rows.push([{ text: 'Открыть заказ на сайте', url }]);
  }
  const text = lines.join('\n').slice(0, 3900);
  return { text, keyboard: { inline_keyboard: rows },
    fallback: orderFallback(text.split('\n'), [lines[0]!, order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка', nextStaffAction(order),
      'Итого: ' + money(order.finalTotal), paymentLabel(order.payment), progressLabel(order)]),
    rich: orderRich(order, { title: lines[0]!, person: clean(order.customerName, 100), next: nextStaffAction(order), sellerActions: order.issues.filter(issue => sellerIssueItem(order, issue)).length,
      details: [clean(order.customerPhone, 40), ...(order.type === 'DELIVERY' ? [clean(formatAddress(order), 200)] : []),
        ...(order.comment ? [clean(order.comment, 300)] : []), ...(order.delivery ? ['Доставка: ' + deliveryText[order.delivery.status]] : [])],
      items: [...order.items.slice(0, 5).map(item => clean(item.productName, 160) + '\nЗаказано: ' + quantity(item.qty, item.unit) + ' · ' + itemStatusText[item.status] +
        (item.status === 'PICKED' && item.actualQty != null ? '\nСобрано: ' + quantity(item.actualQty, item.unit) +
          (variableWeight(item) && item.actualWeightGrams != null ? '\nФактический вес: ' + quantity(item.actualWeightGrams, 'GRAM') : '') +
          (item.actualTotal != null ? '\nФактически за товар: ' + money(item.actualTotal) : '') : '')),
        ...(order.items.length > 5 ? ['Ещё позиций: ' + (order.items.length - 5) + '. Откройте позиции заказа.'] : []),
        ...order.extras.filter(extra => extra.status === 'ACTIVE').slice(0, 5).map(extra => clean(extra.title, 160) + ' · ' + money(extra.amount))] }),
  };
}

export function itemPage(order: OrderView, offset: number): { text: string; keyboard: Keyboard } {
  offset = Math.min(Math.max(0, Math.floor(offset / 8) * 8), Math.max(0, Math.floor((order.items.length - 1) / 8) * 8));
  const page = order.items.slice(offset, offset + 8);
  const rows: Button[][] = page.map(item => {
    const state = item.status === 'PENDING' && (item.unit === 'GRAM' || variableWeight(item)) ? 'нужен вес' : itemStatusText[item.status];
    const row: Button[] = [{
      text: (item.status === 'PICKED' ? '✅ ' : item.status === 'MISSING' ? '❌ ' :
        item.unit === 'GRAM' || variableWeight(item) ? '⚖️ ' : '⬜ ') + clean(item.productName, 28) +
        ' — ' + quantity(item.qty, item.unit) + ' · ' + state +
        (item.status === 'PICKED' && item.actualQty != null
          ? ' · факт: ' + quantity(item.actualQty, item.unit) +
            (item.actualTotal != null ? ' · ' + money(item.actualTotal) : '') : ''),
      callback_data: staffData(order.id, 'v', item.id),
    }];
    if (canQuickConfirm(order, item))
      row.push({ text: '✅ По заказу', callback_data: staffData(order.id, 'a', item.id) });
    return row;
  });
  const nav: Button[] = [];
  if (offset > 0) nav.push({ text: '⬅️', callback_data: staffData(order.id, 'i', Math.max(0, offset - 8)) });
  if (offset + 8 < order.items.length)
    nav.push({ text: '➡️', callback_data: staffData(order.id, 'i', offset + 8) });
  if (nav.length) rows.push(nav);
  if (order.items.some(item => canQuickConfirm(order, item)))
    rows.push([{ text: '✅ Подтвердить все штучные', callback_data: staffData(order.id, 'k') }]);
  rows.push([{ text: '⬅️ Назад к заказу', callback_data: staffData(order.id, 'o') }]);
  return {
    text: 'Заказ #' + order.id + ' · позиции ' + (page.length ? offset + 1 : 0) + '–' + (offset + page.length) +
      ' из ' + order.items.length + '\n' + assemblyProgress(order), keyboard: { inline_keyboard: rows },
  };
}

export function itemView(order: OrderView, item: OrderView['items'][number], url?: string):
  { text: string; keyboard: Keyboard } {
  const lines = [
    'Заказ #' + order.id + ' · ' + clean(item.productName, 120),
    assemblyProgress(order),
    'Заказано: ' + quantity(item.qty, item.unit),
    'Цена: ' + money(item.price) + ' / ' + quantity(item.priceQty, priceUnit(item)),
    ...(item.actualPrice != null && item.actualPrice !== item.price ?
      ['Фактическая цена: ' + money(item.actualPrice) + ' / ' + quantity(item.priceQty, priceUnit(item))] : []),
    'Предварительно за позицию: ' + money(item.total),
    'Статус: ' + (item.status === 'PICKED' ? '✅ Собран' :
      item.status === 'MISSING' ? '❌ Нет в наличии' : 'В сборке'),
  ];
  if (item.actualQty != null) lines.push('Собрано: ' + quantity(item.actualQty, item.unit));
  if (variableWeight(item)) {
    lines.push('Взвесьте каждый экземпляр на сайте. Оплата по фактическому весу.');
    if (item.actualWeightGrams != null) lines.push('Общий вес: ' + quantity(item.actualWeightGrams, 'GRAM'));
  }
  if (item.actualTotal != null) lines.push('Фактически за позицию: ' + money(item.actualTotal));
  lines.push(...issueText(order, item));
  if (order.comment) lines.push('Комментарий к заказу: ' + clean(order.comment, 300));
  const issue = relatedIssue(order, item.id);
  if (canReset(order, item) && issue?.orderItemId === item.id &&
    issue.status === 'RESOLVED' && issue.resolution === 'ACCEPT_ACTUAL')
    lines.push('При возврате в сборку прежнее согласование перестанет действовать. Новый результат проверим заново.');
  const rows: Button[][] = [];
  if (order.status === 'ASSEMBLING') {
    if (item.status === 'PENDING') {
      if (canQuickConfirm(order, item))
        rows.push([{ text: '✅ По заказу', callback_data: staffData(order.id, 'a', item.id) }]);
      if (!variableWeight(item)) rows.push([{ text: item.unit === 'GRAM' ? '⚖️ Ввести вес' : '✏️ Изменить количество',
        callback_data: staffData(order.id, item.unit === 'GRAM' ? 'w' : 'q', item.id) }]);
      rows.push([{ text: '❌ Нет в наличии', callback_data: staffData(order.id, 'm', item.id) }]);
    } else if (canReset(order, item)) rows.push([{
      text: issue?.status === 'WAITING_SELLER' ? '⚖️ Исправить вес' : '↩️ Вернуть в сборку',
      callback_data: staffData(order.id, 'r', item.id),
    }]);
  }
  if (order.status === 'ASSEMBLING') {
    const next = nextAssemblyItem(order, item.id);
    if (next && next.id !== item.id) rows.push([{
      text: item.status === 'PENDING' ? 'Пропустить →' : 'Следующая →',
      callback_data: staffData(order.id, 'v', next.id),
    }]);
  }
  if ((item.unit === 'GRAM' || variableWeight(item)) && url) {
    const weigh = staffWeighUrl(url, item.id);
    if (weigh) rows.push([{ text: '⚖️ Открыть форму взвешивания', url: weigh, style: 'primary' }]);
  }
  if (issue && waitingStatuses.includes(issue.status) && /^\+?[0-9]{10,15}$/.test(order.customerPhone ?? ''))
    rows.push([{ text: 'Скопировать телефон покупателя', copy_text: { text: order.customerPhone } }]);
  if (order.issues.some(value => waitingStatuses.includes(value.status) || sellerIssueItem(order, value)))
    rows.push([{ text: '❗ Вопросы и ответы', callback_data: staffData(order.id, 'j') }]);
  rows.push([{ text: '⬅️ К позициям', callback_data: staffData(order.id, 'i',
    Math.floor(order.items.findIndex(value => value.id === item.id) / 8) * 8) }],
    [{ text: 'К заказу', callback_data: staffData(order.id, 'o') }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function extraPage(order: OrderView, offset = 0): { text: string; keyboard: Keyboard } {
  const active = order.extras.filter(extra => extra.status === 'ACTIVE');
  offset = Math.min(Math.max(0, Math.floor(offset / 10) * 10), Math.max(0, Math.floor((active.length - 1) / 10) * 10));
  const extras = active.slice(offset, offset + 10);
  const rows: Button[][] = extras.flatMap(extra => [[
    { text: '✏️ ' + clean(extra.title, 30), callback_data: staffData(order.id, 'xe', extra.id) },
    { text: '❌', callback_data: staffData(order.id, 'xd', extra.id) },
  ]]);
  rows.push([{ text: '⬅️ Назад к заказу', callback_data: staffData(order.id, 'o') }]);
  const nav: Button[] = [];
  if (offset > 0) nav.push({ text: '← Предыдущие', callback_data: staffData(order.id, 'xl', offset - 10) });
  if (offset + 10 < active.length) nav.push({ text: 'Следующие →', callback_data: staffData(order.id, 'xl', offset + 10) });
  if (nav.length) rows.unshift(nav);
  return { text: 'Доп. позиции заказа #' + order.id + '\n' +
    extras.map(extra => clean(extra.title, 80) + ' · ' + extra.quantity + ' × ' +
      money(extra.unitPrice) + ' = ' + money(extra.amount)).join('\n'),
  keyboard: { inline_keyboard: rows } };
}
