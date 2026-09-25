import type { OrderService } from '../order/order.service.js';
import type { CoordinationService } from '../order/coordination.service.js';
import type { OrderStatus, Unit, DeliveryStatus, PaymentStatus } from '../db/gen/client.js';
import { shoppingData } from './shopping-callback.js';
import { goodsLine } from '../order/pricing.js';
import { customerView, customerDecision, decisionCodes, type DecisionCode } from './customer-callback.js';

export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = { inline_keyboard: Button[][] };
export type Screen = { text: string; keyboard: Keyboard };
export type CustomerOrder = Awaited<ReturnType<OrderService['get']>>;
export type CustomerIssue = Awaited<ReturnType<CoordinationService['view']>>['issues'][number];
export const activeStatuses: OrderStatus[] = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'];
export const orderStatus: Record<OrderStatus, string> = {
  NEW: 'Принят', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Собирается', READY: 'Собран',
  DELIVERING: 'В пути', COMPLETED: 'Завершён', CANCELED: 'Отменён',
};
export const deliveryStatus: Record<DeliveryStatus, string> = {
  PENDING: 'Оформляется', ASSIGNED: 'Курьер назначен', PICKED_UP: 'В пути',
  DELIVERED: 'Доставлен', CANCELED: 'Отменена',
};
const paymentStatus: Record<PaymentStatus, string> = {
  AWAITING: 'Ожидается', REPORTED: 'Проверяется', PAID: 'Получена', CANCELED: 'Отменена',
};
export function short(text: string, limit = 180) {
  const clean = text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
}
export function amount(value: number | null | undefined) {
  return value == null ? 'уточняется' : new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: value % 100 ? 2 : 0, maximumFractionDigits: 2,
  }).format(value / 100) + ' ₽';
}
export function quantity(value: number, unit: Unit) {
  const n = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
  if (unit === 'GRAM') return value >= 1000 ? n.format(value / 1000) + ' кг' : n.format(value) + ' г';
  if (unit === 'BUNCH') {
    const last = value % 10, hundred = value % 100;
    return n.format(value) + ' ' + (last === 1 && hundred !== 11 ? 'пучок' :
      last >= 2 && last <= 4 && (hundred < 12 || hundred > 14) ? 'пучка' : 'пучков');
  }
  return n.format(value) + (unit === 'PIECE' ? ' шт.' : ' уп.');
}
export const displayId = (id: string) => id.slice(0, 8).toUpperCase();
export const date = (value: Date) => new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
}).format(value);
export function siteUrl(path: string) {
  try {
    const origin = new URL(process.env.ORDER_SITE_URL ?? '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
      !path.startsWith('/') || path.startsWith('//')) return undefined;
    const url = new URL(path, origin);
    return url.origin === origin.origin ? url.href : undefined;
  } catch { return undefined; }
}
export function orderLinks(publicId: string): Button[][] {
  const url = siteUrl('/order/' + publicId);
  return [
    ...(url ? [[{ text: 'Открыть заказ на сайте', url }]] : []),
    [{ text: '📦 Мои заказы', callback_data: 'orders' }, { text: 'Меню', callback_data: 'menu' }],
  ];
}
export function orderCard(order: CustomerOrder, issues: CustomerIssue[], page = 0): Screen {
  const size = 5, lines: string[] = order.items.map(item => [
    short(item.productName),
    'Заказано: ' + quantity(item.qty, item.unit) + ' · ' + amount(item.total),
    ...(item.status === 'MISSING' ? ['❌ Нет в составе заказа'] :
      item.actualQty != null ? ['Собрано: ' + quantity(item.actualQty, item.unit) + ' · ' + amount(item.actualTotal)] : []),
  ].join('\n'));
  lines.push(...order.extras.map(extra => '➕ ' + short(extra.title) + '\n' + extra.quantity + ' × ' + amount(extra.unitPrice) + ' = ' + amount(extra.amount)));
  const pages = Math.max(1, Math.ceil(lines.length / size));
  page = Math.min(page, pages - 1);
  const header = [
    'Заказ #' + displayId(order.publicId) + ' · ' + orderStatus[order.status],
    (order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка') + ' · ' + date(order.createdAt),
    ...(order.deliveryAt ? ['Получение: ' + date(order.deliveryAt)] : []),
    'При заказе: ' + amount(order.total),
    ...(order.total === null ? ['Товары при заказе: ' + amount(order.subtotal), 'Стоимость доставки уточняется'] : []),
    ...(order.finalSubtotal !== null ? ['Итог за товары: ' + amount(order.finalSubtotal), 'Итого: ' + amount(order.finalTotal)] : []),
    ...(order.customerUnread ? ['Новых сообщений: ' + order.customerUnread] : []),
    'Оплата: ' + (order.payment ? paymentStatus[order.payment.status] : 'после сборки'),
    ...(order.payment ? ['Сумма оплаты товаров: ' + amount(order.payment.amount)] : []),
    ...(order.type === 'DELIVERY' ? ['Доставка: ' + amount(order.deliveryPrice)] : []),
    ...(order.delivery ? ['Доставка: ' + deliveryStatus[order.delivery.status],
      ...(order.delivery.courierName ? ['Курьер: ' + short(order.delivery.courierName,100)] : []),
      ...(order.delivery.courierPhone ? ['Телефон курьера: ' + short(order.delivery.courierPhone,40)] : [])] : []),
  ];
  const waiting = issues.filter(issue => issue.actions.length);
  const keyboard: Button[][] = [];
  if (order.assemblyFinalizedAt && order.payment && order.payment.status !== 'CANCELED' && order.status !== 'CANCELED')
    keyboard.push([{text:'💳 Оплата',callback_data:shoppingData('p',order.publicId,'SBP')}]);
  if (order.delivery?.trackingUrl) {
    try { const url = new URL(order.delivery.trackingUrl);
      const orderUrl = siteUrl('/order/' + order.publicId);
      if (url.protocol === 'https:' && !url.username && !url.password && orderUrl)
        keyboard.push([{text:'Отследить доставку',url:orderUrl}]);
    } catch { /* Invalid provider URLs are never rendered. */ }
  }
  if (pages > 1) keyboard.push([
    ...(page ? [{ text: '← Товары', callback_data: customerView('o', order.publicId, page - 1) }] : []),
    ...(page + 1 < pages ? [{ text: 'Товары →', callback_data: customerView('o', order.publicId, page + 1) }] : []),
  ]);
  if (waiting.length) keyboard.push([{ text: '❗ Требуется решение (' + waiting.length + ')', callback_data: customerView('q', order.publicId) }]);
  keyboard.push(
    [{ text: '💬 Сообщения', callback_data: customerView('m', order.publicId) }, { text: 'Написать продавцу', callback_data: customerView('w', order.publicId) }],
    [{ text: '🔄 Обновить', callback_data: customerView('o', order.publicId, page) }],
    ...orderLinks(order.publicId),
  );
  return { text: header.join('\n') + '\n\n' + lines.slice(page * size, (page + 1) * size).join('\n\n') +
    (pages > 1 ? '\n\nТовары: страница ' + (page + 1) + ' из ' + pages : ''),
    keyboard: { inline_keyboard: keyboard } };
}
const labels: Record<DecisionCode, string> = {
  a: '✅ Принять фактический вес', r: '⚖️ Попросить уменьшить', x: 'Убрать товар',
  p: '✅ Принять замену', c: '❌ Отменить весь заказ',
};
export function issueCard(publicId: string, issues: CustomerIssue[], page = 0): Screen {
  const waiting = issues.filter(issue => issue.actions.length);
  const issue = waiting[Math.min(page, waiting.length - 1)];
  if (!issue) return { text: 'Сейчас нет вопросов, требующих вашего решения.', keyboard: { inline_keyboard: [[{
    text: '← К заказу', callback_data: customerView('o', publicId),
  }]] } };
  page = Math.min(page, waiting.length - 1);
  const lines = ['Заказ #' + displayId(publicId) + ' · Требуется ваше решение', short(issue.orderItem.productName)];
  if (issue.type === 'WEIGHT_DEVIATION') {
    lines.push('Заказано: ' + quantity(issue.requestedQty, issue.orderItem.unit),
      'Фактически: ' + quantity(issue.actualQty!, issue.orderItem.unit),
      'При заказе: ' + amount(goodsLine(issue.orderItem.price, issue.requestedQty, issue.orderItem.priceQty)),
      'По факту: ' + amount(goodsLine(issue.orderItem.price, issue.actualQty!, issue.orderItem.priceQty)));
  } else lines.push('Товар отсутствует.');
  if (issue.type === 'REPLACEMENT' && issue.proposedName && issue.proposedQty && issue.proposedUnit && issue.proposedPrice && issue.proposedPriceQty) {
    lines.push('Продавец предлагает замену:', short(issue.proposedName),
      quantity(issue.proposedQty, issue.proposedUnit) + ' · ' + amount(issue.proposedPrice) + ' / ' + quantity(issue.proposedPriceQty, issue.proposedUnit),
      'Сумма: ' + amount(goodsLine(issue.proposedPrice, issue.proposedQty, issue.proposedPriceQty)));
  }
  const keyboard: Button[][] = (Object.keys(decisionCodes) as DecisionCode[]).filter(code => issue.actions.includes(decisionCodes[code]))
    .map(code => [{ text: labels[code], callback_data: customerDecision(publicId, issue.id, issue.version, code) }]);
  if (waiting.length > 1) keyboard.push([
    ...(page ? [{ text: '← Вопрос', callback_data: customerView('q', publicId, page - 1) }] : []),
    ...(page + 1 < waiting.length ? [{ text: 'Следующий вопрос →', callback_data: customerView('q', publicId, page + 1) }] : []),
  ]);
  keyboard.push([{ text: '← К заказу', callback_data: customerView('o', publicId) }]);
  return { text: lines.join('\n\n'), keyboard: { inline_keyboard: keyboard } };
}
