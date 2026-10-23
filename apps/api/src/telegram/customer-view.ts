import type { OrderService } from '../order/order.service.js';
import type { CoordinationService } from '../order/coordination.service.js';
import type { OrderStatus, Unit, DeliveryStatus } from '../db/gen/client.js';
import { shoppingData } from './shopping-callback.js';
import { goodsLine, requestedLine } from '../order/pricing.js';
import { priceUnit, variableWeight } from '../product/sale.js';
import { customerView, customerDecision, customerConfirmCancellation, decisionCodes, type DecisionCode } from './customer-callback.js';
import { orderRich, orderFallback, paymentLabel, progressLabel } from './order-rich.js';

export type Button = import('./rich.js').TelegramButton;
export type Keyboard = { inline_keyboard: Button[][] };
export type Screen = import('./rich.js').TelegramScreen;
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
export function short(text: string, limit = 180) {
  const clean = text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
  return clean.length > limit ? clean.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…' : clean;
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
export function webAppUrl(path: string): string | undefined {
  // Matches the customer-only returnTo allowlist on the WebApp entry page.
  const customerPage = ['/', '/catalog', '/quick-shop', '/orders', '/profile', '/cart', '/favorites', '/delivery', '/how-it-works'].includes(path);
  const order = /^\/order\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?chatMessage=[1-9][0-9]{0,9})?(?:#order-chat)?$/i.test(path);
  const slug = /^\/(?:catalog|product)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
  return path.length <= 189 && (customerPage || order || slug)
    ? siteUrl('/telegram?returnTo=' + encodeURIComponent(path))
    : undefined;
}
type CustomerMenuData = {
  attention: { id: number; customerUnread?: number; issues?: { id: number }[] } | null;
  current: { id: number; status: OrderStatus } | null;
  cartLabel: string;
};
export function customerMenu(
  identity: { firstName: string | null; user: { name: string | null } },
  data: CustomerMenuData,
): Screen {
  const { attention, current, cartLabel } = data;
  const questions = attention?.issues?.length ?? 0;
  return {
    text: 'KorzinaMarket\nПривет, ' + short(identity.user.name || identity.firstName || 'покупатель', 80) + '!\n' +
      (attention ? questions
        ? '❗ По заказу №' + attention.id + ' ждём ваше решение. Откройте вопросы, чтобы продолжить сборку.\n\n'
        : '💬 По заказу №' + attention.id + ' есть непрочитанные обновления.\n\n' : '') +
      (current ? '📦 Заказ №' + current.id + ' · ' + orderStatus[current.status] + '\n\n' : '') +
      'Свежие продукты с московского рынка — прямо в чате.',
    keyboard: { inline_keyboard: [
      ...(attention ? [[{ text: questions ? '❗ Нужен ваш ответ' : '💬 Непрочитанные сообщения', callback_data: 'attention', style: 'primary' as const }]] : []),
      ...(current ? [[{ text: '📦 Заказ №' + current.id + ' · ' + orderStatus[current.status], callback_data: 'current' }]] : []),
      [{ text: '🛍 Каталог', callback_data: 'catalog', style: 'primary' }],
      [{ text: cartLabel, callback_data: 'cart' }],
      [{ text: '⚡ Быстрые покупки', callback_data: shoppingData('q', 0) }],
      [{ text: '📦 История', callback_data: 'orders' }, { text: '💬 Связь с продавцом', callback_data: 'current' }],
      [{ text: 'Помощь', callback_data: 'help' }],
    ] },
  };
}

export function customerOnboardingMenu(identity: { firstName: string | null; user: { name: string | null } }): Screen {
  const about = webAppUrl('/how-it-works'), delivery = webAppUrl('/delivery');
  return {
    text: 'Привет, ' + short(identity.user.name || identity.firstName || 'покупатель', 80) + '!\n\n' +
      'Добро пожаловать в KorzinaMarket. Посмотрите продукты и цены в каталоге.\n\n' +
      'Для корзины, оформления и доступа к заказам подтвердите свой номер кнопкой ниже. В Telegram нужно поделиться своим контактом.',
    keyboard: { inline_keyboard: [
      [{ text: '🛍 Посмотреть каталог', callback_data: 'catalog' }],
      [{ text: '📱 Подтвердить свой номер', callback_data: 'verify_phone', style: 'primary' }],
      [{ text: 'ℹ️ Как всё устроено', callback_data: 'help' }],
      ...((about || delivery) ? [[
        ...(about ? [{ text: 'О сервисе', web_app: { url: about } }] : []),
        ...(delivery ? [{ text: 'Доставка и самовывоз', web_app: { url: delivery } }] : []),
      ]] : []),
    ] },
  };
}

type Address = Partial<Record<'city' | 'street' | 'house' | 'buildingPart' | 'flat' | 'entrance' | 'floor' | 'intercom' | 'comment', string | null>>;
export function addressLines(address: Address): string[] {
  const place = [address.city, address.street && 'ул. ' + address.street, address.house && 'д. ' + address.house,
    address.buildingPart].filter(Boolean).join(', ');
  const access = [address.flat && 'кв. ' + address.flat, address.entrance && 'подъезд ' + address.entrance,
    address.floor && 'этаж ' + address.floor, address.intercom && 'домофон ' + address.intercom].filter(Boolean).join(' · ');
  return [...(place ? ['📍 ' + short(place, 350)] : []), ...(access ? [short(access, 160)] : []),
    ...(address.comment ? ['Комментарий: ' + short(address.comment, 300)] : [])];
}

function waitingIssues(order: CustomerOrder) {
  return order.status === 'ASSEMBLING' && !order.assemblyFinalizedAt &&
    !['PAID', 'REPORTED'].includes(order.payment?.status ?? '')
    ? order.issues.filter(issue => issue.status === 'WAITING_CUSTOMER') : [];
}
export function orderNextStep(order: CustomerOrder): string {
  if (order.status === 'CANCELED') return 'Заказ отменён. Если остались вопросы, напишите продавцу в этом заказе.';
  if (order.status === 'COMPLETED') return '✅ Заказ завершён. Повторить покупки можно через меню «Быстрые покупки».';
  if (waitingIssues(order).length) return '❗ Следующий шаг: ответьте на вопросы о товарах. Без ответа эти изменения не согласованы.';
  if (order.assemblyFinalizedAt && order.payment?.status === 'AWAITING')
    return '💳 Следующий шаг: откройте оплату и переведите точную сумму за собранные товары. Продавец проверит поступление.';
  if (order.payment?.status === 'REPORTED') return '🕓 Продавец проверяет оплату. Повторно переводить деньги не нужно.';
  if (order.status === 'DELIVERING') return '🚚 Заказ в пути. Данные курьера и отслеживание — ниже; по вопросам напишите продавцу.';
  if (order.status === 'READY') return order.type === 'PICKUP'
    ? '🛍 Заказ собран. Перед выездом уточните у продавца место и готовность к выдаче.'
    : '📦 Заказ собран. Продавец уточнит передачу курьеру; изменения доставки появятся здесь.';
  if (order.status === 'ASSEMBLING') return '🧺 Продавец собирает заказ. Здесь появятся фактический вес, замены и итоговая сумма.';
  return order.scheduledFor ? '🗓 Подготовка запланирована на ' + date(order.scheduledFor) + '. Изменения можно обсудить с продавцом.'
    : order.status === 'CONFIRMED' ? '✅ Заказ подтверждён. Сообщим о начале сборки и вопросах по товарам.'
      : '🕓 Заказ принят. Ожидайте подтверждения продавца; пожелания можно отправить в сообщения заказа.';
}

export function cancelOrderScreen(order: Pick<CustomerOrder, 'id' | 'publicId'>, issue: CustomerIssue): Screen {
  return {
    text: '❗ Отменить весь заказ №' + order.id + '?\n\n' +
      'Будут отменены все товары заказа, включая уже согласованные. Отмена только одной позиции доступна в вопросе о товаре.\n\n' +
      'Если хотите уточнить замену или вес, сначала напишите продавцу.',
    keyboard: { inline_keyboard: [
      [{ text: 'Сохранить заказ · вернуться к вопросу', callback_data: customerView('q', order.publicId), style: 'primary' }],
      [{ text: '💬 Уточнить у продавца', callback_data: customerView('w', order.publicId) }],
      [{ text: 'Да, отменить весь заказ', callback_data: customerConfirmCancellation(order.publicId, issue.id, issue.version), style: 'danger' }],
    ] },
  };
}

export function orderLinks(publicId: string): Button[][] {
  const url = webAppUrl('/order/' + publicId);
  return [
    ...(url ? [[{ text: 'Открыть заказ на сайте', web_app: { url } }]] : []),
    [{ text: '📦 Мои заказы', callback_data: 'orders' }, { text: 'Меню', callback_data: 'menu' }],
  ];
}
export function orderCard(order: CustomerOrder, page = 0): Screen {
  const size = 5;
  const issueByItem = new Map(order.issues.map(issue => [issue.orderItemId, issue]));
  const replacementIds = new Set(order.issues.map(issue => issue.replacementItemId).filter(id => id !== null));
  const lines: string[] = order.items.map(item => {
    const issue = issueByItem.get(item.id);
    return [
      (replacementIds.has(item.id) ? '🔁 Замена: ' : '') + short(item.productName),
      'Заказано: ' + quantity(item.qty, item.unit),
      ...(item.actualPrice != null && item.actualPrice !== item.price ?
        ['Цена изменена: ' + amount(item.price) + ' → ' + amount(item.actualPrice)] : []),
      ...(item.status === 'MISSING' ? ['❌ Нет в наличии'] : item.status === 'PICKED' && item.actualQty !== null
        ? [(item.unit === 'GRAM' ? '⚖️ ' : '✅ ') + 'Собрано: ' + quantity(item.actualQty, item.unit) +
          (variableWeight(item) && item.actualWeightGrams != null ? ' · ' + quantity(item.actualWeightGrams, 'GRAM') : '') +
          (item.actualTotal !== null ? ' · ' + amount(item.actualTotal) : '')] : []),
      ...(issue?.type === 'REPLACEMENT' && (issue.status === 'WAITING_CUSTOMER' || issue.resolution === 'ACCEPT_REPLACEMENT') &&
        issue.proposedName && issue.proposedQty && issue.proposedUnit
        ? [(issue.resolution === 'ACCEPT_REPLACEMENT' ? '✅ Замена принята: ' : 'Предложена замена: ') +
          short(issue.proposedName) + ' · ' + quantity(issue.proposedQty, issue.proposedUnit)] : []),
    ].join('\n');
  });
  lines.push(...order.extras.map(extra => '➕ ' + short(extra.title) + '\n' + extra.quantity + ' × ' + amount(extra.unitPrice) + ' = ' + amount(extra.amount) +
    (extra.comment ? '\n' + short(extra.comment, 140) : '')));
  const header = [
    'Заказ №' + order.id + ' · ' + orderStatus[order.status],
    orderNextStep(order),
    (order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка') + ' · ' + date(order.createdAt),
    ...(order.deliveryAt ? ['Получение: ' + date(order.deliveryAt)] : []),
    ...(order.scheduledFor ? ['Предзаказ. Подготовить к: ' + date(order.scheduledFor)] : []),
    ...(order.customerName ? ['Получатель: ' + short(order.customerName, 100)] : []),
    ...(order.customerPhone ? ['Телефон: ' + short(order.customerPhone, 30)] : []),
    ...(order.type === 'DELIVERY' ? addressLines(order) : []),
    'При заказе: ' + amount(order.total),
    ...(order.promoCodeSnapshot ? ['Промокод: ' + short(order.promoCodeSnapshot, 32) + ' · скидка ' + amount(order.finalPromoDiscount ?? order.promoDiscount)] : []),
    ...(order.total === null ? ['Товары при заказе: ' + amount(order.subtotal), 'Стоимость доставки уточняется'] : []),
    ...(order.finalSubtotal !== null ? ['Итог за товары: ' + amount(order.finalSubtotal), 'Итого: ' + amount(order.finalTotal)] :
      order.status === 'ASSEMBLING' && order.extras.length ? ['Доп. позиции: ' + amount(order.extras.reduce((sum, extra) => sum + extra.amount, 0))] : []),
    ...(order.customerUnread ? ['Обновлений в чате: ' + order.customerUnread] : []),
    paymentLabel(order.payment), progressLabel(order),
    ...(order.payment ? ['Сумма оплаты товаров: ' + amount(order.payment.amount)] : []),
    ...(order.type === 'DELIVERY' ? ['Доставка: ' + amount(order.deliveryPrice)] : []),
    ...(order.delivery ? ['Доставка: ' + deliveryStatus[order.delivery.status],
      ...(order.delivery.courierName ? ['Курьер: ' + short(order.delivery.courierName,100)] : []),
      ...(order.delivery.courierPhone ? ['Телефон курьера: ' + short(order.delivery.courierPhone,40)] : [])] : []),
  ];
  const headerText = header.join('\n');
  const chunks: string[][] = [[]];
  // Leave room for the footer; verbose addresses and replacement snapshots reduce page size.
  const budget = 3900 - headerText.length - 180;
  for (const line of lines) {
    let chunk = chunks.at(-1)!;
    if (chunk.length && (chunk.length >= size || chunk.join('\n\n').length + line.length + 2 > budget)) {
      chunk = [];
      chunks.push(chunk);
    }
    chunk.push(line);
  }
  const pages = chunks.length;
  page = Math.min(page, pages - 1);
  const waiting = waitingIssues(order);
  const keyboard: Button[][] = [];
  if (waiting.length) keyboard.push([{ text: '❗ Требуется решение (' + waiting.length + ')', callback_data: customerView('q', order.publicId), style: 'primary' }]);
  if (order.assemblyFinalizedAt && order.payment && order.payment.status !== 'CANCELED' && order.status !== 'CANCELED')
    keyboard.push([{ text: order.payment.status === 'PAID' ? '✅ Оплата получена' : order.payment.status === 'REPORTED' ? '🕓 Проверка оплаты' : '💳 Оплата · ' + amount(order.payment.amount),
      callback_data: shoppingData('p', order.publicId, 'SBP'), ...(order.payment.status === 'AWAITING' ? { style: 'success' as const } : {}) }]);
  if (order.delivery?.trackingUrl) {
    try { const url = new URL(order.delivery.trackingUrl);
      const orderUrl = webAppUrl('/order/' + order.publicId);
      if (url.protocol === 'https:' && !url.username && !url.password && orderUrl)
        keyboard.push([{text:'Отследить доставку',web_app:{url:orderUrl}}]);
    } catch { /* Invalid provider URLs are never rendered. */ }
  }
  if (pages > 1) keyboard.push([
    ...(page ? [{ text: '← Товары', callback_data: customerView('o', order.publicId, page - 1) }] : []),
    ...(page + 1 < pages ? [{ text: 'Товары →', callback_data: customerView('o', order.publicId, page + 1) }] : []),
  ]);
  keyboard.push(
    [{ text: '💬 Сообщения' + (order.customerUnread ? ' · ' + order.customerUnread : ''), callback_data: customerView('m', order.publicId) }, { text: 'Написать продавцу', callback_data: customerView('w', order.publicId) }],
    [{ text: '🔄 Обновить', callback_data: customerView('o', order.publicId, page) }],
    ...orderLinks(order.publicId),
  );
  const text = headerText + '\n\n' + chunks[page]!.join('\n\n') +
    (order.status === 'ASSEMBLING' ? '\n\nФактический вес и доп. позиции войдут в итоговую сумму после сборки.' : '') +
    (pages > 1 ? '\n\nТовары: страница ' + (page + 1) + ' из ' + pages : '');
  return { text, keyboard: { inline_keyboard: keyboard },
    fallback: orderFallback(text.split('\n'), [header[0]!, header[1]!, header[2]!, paymentLabel(order.payment), progressLabel(order),
      'Итого: ' + amount(order.finalTotal)]),
    rich: orderRich(order, { title: header[0]!, person: short(order.customerName ?? '', 100), next: orderNextStep(order),
      details: ['Создан: ' + date(order.createdAt), ...(order.customerPhone ? ['Телефон: ' + short(order.customerPhone, 30)] : []),
        ...(order.type === 'DELIVERY' ? addressLines(order) : []),
        ...(order.deliveryAt ? ['Получение: ' + date(order.deliveryAt)] : []), ...(order.scheduledFor ? ['Подготовить к: ' + date(order.scheduledFor)] : []),
        ...(order.delivery ? ['Доставка: ' + deliveryStatus[order.delivery.status], ...(order.delivery.courierName ? ['Курьер: ' + short(order.delivery.courierName, 100)] : []),
          ...(order.delivery.courierPhone ? ['Телефон курьера: ' + short(order.delivery.courierPhone, 40)] : [])] : [])],
      items: [...chunks[page]!, ...(pages > 1 ? ['Страница ' + (page + 1) + ' из ' + pages] : [])] }),
  };
}
type IssueOrder = Pick<CustomerOrder, 'id' | 'publicId'> & Partial<Pick<CustomerOrder, 'items'>>;
const signedQuantity = (value: number, unit: Unit) =>
  (value > 0 ? '+' : value < 0 ? '−' : '') + quantity(Math.abs(value), unit);
const signedAmount = (before: number | null, after: number | null) => before === null || after === null
  ? 'уточняется' : (after > before ? '+' : after < before ? '−' : '') + amount(Math.abs(after - before));
const issueAmount = (value: number | null) => value === null ? 'сумма после взвешивания' : amount(value);

function requestedIssueAmount(order: IssueOrder, issue: CustomerIssue): number | null {
  const item = order.items?.find(item => item.id === issue.orderItemId && item.qty === issue.requestedQty);
  if (item && item.total !== undefined) return item.total;
  // Quantity is a count for whole variable-weight products, never grams.
  return variableWeight(issue.orderItem) ? null : goodsLine(issue.orderItem.price, issue.requestedQty, issue.orderItem.priceQty);
}

function actualIssueAmount(issue: CustomerIssue): number | null {
  const qty = variableWeight(issue.orderItem) ? issue.actualWeightGrams : issue.actualQty;
  return qty == null ? null : goodsLine(issue.orderItem.actualPrice ?? issue.orderItem.price, qty, issue.orderItem.priceQty);
}

function proposedIssueAmount(issue: CustomerIssue): number | null {
  if (!issue.proposedUnit || !issue.proposedQty || !issue.proposedPrice || !issue.proposedPriceQty) return null;
  return requestedLine({ unit: issue.proposedUnit, priceUnit: issue.proposedPriceUnit,
    saleModel: issue.proposedSaleModel, estimatedWeightGrams: issue.proposedEstimatedWeightGrams,
    qty: issue.proposedQty, price: issue.proposedPrice, priceQty: issue.proposedPriceQty });
}

export function issueCard(order: IssueOrder, issues: CustomerIssue[], page = 0): Screen {
  const publicId = order.publicId;
  const waiting = issues.filter(issue => issue.status === 'WAITING_CUSTOMER' && issue.actions.length);
  const issue = waiting[Math.min(page, waiting.length - 1)];
  if (!issue) return { text: 'Сейчас нет вопросов, требующих вашего решения.', keyboard: { inline_keyboard: [[{
    text: '← К заказу', callback_data: customerView('o', publicId),
  }]] } };
  page = Math.min(page, waiting.length - 1);
  const before = requestedIssueAmount(order, issue);
  const lines = ['Заказ №' + order.id + ' · Требуется ваше решение' +
    (waiting.length > 1 ? ' · ' + (page + 1) + ' из ' + waiting.length : ''), short(issue.orderItem.productName)];
  let actual: number | null = null, proposed: number | null = null;
  let actualQuantity = issue.actualQty == null ? 'количество уточняется' : quantity(issue.actualQty, issue.orderItem.unit);
  if (variableWeight(issue.orderItem) && issue.actualWeightGrams != null)
    actualQuantity += ' · ' + quantity(issue.actualWeightGrams, 'GRAM');
  if (issue.type === 'WEIGHT_DEVIATION') {
    actual = actualIssueAmount(issue);
    lines.push('Заказано: ' + quantity(issue.requestedQty, issue.orderItem.unit),
      'Фактически: ' + actualQuantity,
      'Цена: ' + amount(issue.orderItem.actualPrice ?? issue.orderItem.price) + ' / ' + quantity(issue.orderItem.priceQty, priceUnit(issue.orderItem)),
      issue.actualQty == null ? 'Изменение количества: уточняется' :
        (issue.orderItem.unit === 'GRAM' ? 'Изменение веса: ' : 'Изменение количества: ') +
          signedQuantity(issue.actualQty - issue.requestedQty, issue.orderItem.unit),
      'При заказе: ' + issueAmount(before),
      'По факту: ' + issueAmount(actual),
      'Изменение стоимости: ' + signedAmount(before, actual));
    if (variableWeight(issue.orderItem))
      lines.push('Это целый экземпляр. Просьба уменьшить означает подобрать другой экземпляр; нарезку обсудите с продавцом.');
  } else lines.push('Товар отсутствует.');
  if (issue.type === 'REPLACEMENT' && issue.proposedName && issue.proposedQty && issue.proposedUnit && issue.proposedPrice && issue.proposedPriceQty) {
    proposed = proposedIssueAmount(issue);
    lines.push('Продавец предлагает замену:', short(issue.proposedName),
      'Количество: ' + quantity(issue.requestedQty, issue.orderItem.unit) + ' → ' + quantity(issue.proposedQty, issue.proposedUnit),
      'Цена замены: ' + amount(issue.proposedPrice) + ' / ' + quantity(issue.proposedPriceQty, issue.proposedPriceUnit ?? issue.proposedUnit),
      'При заказе: ' + issueAmount(before), 'Сумма замены: ' + issueAmount(proposed),
      'Изменение стоимости: ' + signedAmount(before, proposed));
  }
  const labels: Record<DecisionCode, string> = {
    a: '✅ Принять ' + actualQuantity + ' · ' + issueAmount(actual),
    r: variableWeight(issue.orderItem) ? '⚖️ Попросить другой экземпляр' : '⚖️ Попросить уменьшить',
    x: 'Убрать только этот товар',
    p: '✅ Заменить: ' + (issue.proposedQty && issue.proposedUnit ? quantity(issue.proposedQty, issue.proposedUnit) : 'количество уточняется') +
      ' · ' + issueAmount(proposed),
    c: '❌ Отменить весь заказ',
  };
  const actionOrder: DecisionCode[] = ['a', 'p', 'r', 'x', 'c'];
  const keyboard: Button[][] = actionOrder.filter(code => issue.actions.includes(decisionCodes[code]))
    .map(code => [{ text: labels[code], callback_data: customerDecision(publicId, issue.id, issue.version, code),
      ...(code === 'a' || code === 'p' ? { style: 'success' as const } :
        code === 'x' || code === 'c' ? { style: 'danger' as const } : {}) }]);
  if (waiting.length > 1) keyboard.push([
    ...(page ? [{ text: '← Вопрос', callback_data: customerView('q', publicId, page - 1) }] : []),
    ...(page + 1 < waiting.length ? [{ text: 'Следующий вопрос →', callback_data: customerView('q', publicId, page + 1) }] : []),
  ]);
  keyboard.push([{ text: '💬 Уточнить у продавца', callback_data: customerView('w', publicId) }]);
  keyboard.push([{ text: '← К заказу', callback_data: customerView('o', publicId) }]);
  if (issue.actions.includes('CANCEL_ORDER')) lines.push('Отмена всего заказа потребует отдельного подтверждения.');
  return { text: lines.join('\n\n'), keyboard: { inline_keyboard: keyboard } };
}
