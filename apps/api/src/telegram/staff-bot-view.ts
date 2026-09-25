import type { StaffService } from '../staff/staff.service.js';
import { clean, money, quantity, staffData } from './staff-bot.js';

export type OrderView = Awaited<ReturnType<StaffService['get']>>;
export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = { inline_keyboard: Button[][] };
export const activeStatuses = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING'] as const;
export const statusText = {
  NEW: 'Новый', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Собирается',
  READY: 'Готов', DELIVERING: 'Доставляется', COMPLETED: 'Завершён', CANCELED: 'Отменён',
} as const;
const paymentText = { AWAITING: 'ожидается', REPORTED: 'сообщена', PAID: 'получена',
  CANCELED: 'отменена' } as const;
const deliveryText = { PENDING: 'ожидается', ASSIGNED: 'назначена',
  PICKED_UP: 'у курьера', DELIVERED: 'доставлена', CANCELED: 'отменена' } as const;
const itemStatusText = { PENDING: 'в сборке', PICKED: 'собран', MISSING: 'нет в наличии' } as const;

export function canQuickConfirm(order: OrderView, item: OrderView['items'][number]): boolean {
  return order.status === 'ASSEMBLING' && item.status === 'PENDING' &&
    (item.unit === 'PIECE' || item.unit === 'PACK' || item.unit === 'BUNCH') &&
    !order.issues.some(issue => issue.orderItemId === item.id || issue.replacementItemId === item.id);
}

export function dashboard(order: OrderView, url?: string): { text: string; keyboard: Keyboard } {
  const id = order.id;
  const lines = [
    'Заказ #' + id + ' · ' + statusText[order.status],
    clean(order.customerName, 100) + ' · ' + clean(order.customerPhone, 40),
    order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка',
  ];
  if (order.type === 'DELIVERY')
    lines.push(clean([order.city, order.street, order.house, order.flat &&
      'кв. ' + order.flat].filter(Boolean).join(', '), 200));
  if (order.comment) lines.push('Комментарий: ' + clean(order.comment, 300));
  lines.push('Товары: ' + money(order.subtotal), 'Доставка: ' + money(order.deliveryPrice),
    'Запрошено: ' + money(order.total));
  if (order.finalSubtotal !== null)
    lines.push('Факт товаров: ' + money(order.finalSubtotal), 'Итого: ' + money(order.finalTotal));
  lines.push('Оплата: ' + (order.payment ? paymentText[order.payment.status] : 'не создана'));
  if (order.payment?.status === 'REPORTED') lines.push('⚠️ Покупатель сообщил об оплате. Проверьте поступление денег.');
  if (order.delivery) lines.push('Доставка: ' +
    (order.delivery.provider === 'YANDEX' ? 'Яндекс' : 'другой курьер') + ' · ' +
    deliveryText[order.delivery.status]);
  lines.push('Позиции: ' + order.items.length + ' · обработано ' +
    order.items.filter(item => item.status !== 'PENDING').length);
  for (const item of order.items.slice(0, 5)) lines.push('• ' + clean(item.productName, 65) +
    ' — ' + quantity(item.qty, item.unit) + ' · ' + itemStatusText[item.status]);
  if (order.items.length > 5) lines.push('…и ещё ' + (order.items.length - 5) + ' позиций');
  if (order.extras.some(extra => extra.status === 'ACTIVE'))
    lines.push('Доп. позиции: ' + order.extras.filter(extra => extra.status === 'ACTIVE').length);

  const rows: Button[][] = [];
  const add = (text: string, action: Parameters<typeof staffData>[1]) =>
    rows.push([{ text, callback_data: staffData(id, action) }]);
  if (order.status === 'NEW') rows.push([{ text: '✅ Подтвердить', callback_data: 'order:' + id + ':confirm' }]);
  if (order.status === 'CONFIRMED')
    rows.push([{ text: '▶️ Начать сборку', callback_data: 'order:' + id + ':assembly' }]);
  if (order.status === 'ASSEMBLING') {
    add('🧺 Позиции', 'i');
    if (order.items.some(item => canQuickConfirm(order, item)))
      add('✅ Подтвердить все штучные', 'k');
    add('➕ Доп. позиция / услуга', 'x');
    if (order.extras.some(extra => extra.status === 'ACTIVE')) add('📋 Доп. позиции', 'xl');
    if (order.items.length && order.items.every(item => item.status !== 'PENDING'))
      add('✅ Завершить сборку', 'f');
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
  add('🔄 Обновить', 'o');
  if (url) rows.push([{ text: 'Открыть заказ на сайте', url }]);
  return { text: lines.join('\n').slice(0, 3900), keyboard: { inline_keyboard: rows } };
}

export function itemPage(order: OrderView, offset: number): { text: string; keyboard: Keyboard } {
  const page = order.items.slice(offset, offset + 8);
  const rows: Button[][] = page.map(item => {
    const state = item.status === 'PENDING' && item.unit === 'GRAM' ? 'нужен вес' : itemStatusText[item.status];
    const row: Button[] = [{
      text: (item.status === 'PICKED' ? '✅ ' : item.status === 'MISSING' ? '❌ ' :
        item.unit === 'GRAM' ? '⚖️ ' : '⬜ ') + clean(item.productName, 28) +
        ' — ' + quantity(item.qty, item.unit) + ' · ' + state,
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
    text: 'Заказ #' + order.id + ' · позиции ' + (offset + 1) + '–' + (offset + page.length) +
      ' из ' + order.items.length, keyboard: { inline_keyboard: rows },
  };
}

export function itemView(order: OrderView, item: OrderView['items'][number]):
  { text: string; keyboard: Keyboard } {
  const lines = [
    'Заказ #' + order.id + ' · ' + clean(item.productName, 120),
    'Заказ: ' + quantity(item.qty, item.unit),
    'Цена: ' + money(item.price) + ' / ' + quantity(item.priceQty, item.unit),
    'Запрошено: ' + money(item.total),
    'Статус: ' + (item.status === 'PICKED' ? '✅ Собран' :
      item.status === 'MISSING' ? '❌ Нет в наличии' : 'В сборке'),
  ];
  if (item.actualQty !== null) lines.push('Факт: ' + quantity(item.actualQty, item.unit));
  if (item.actualTotal !== null) lines.push('Сумма: ' + money(item.actualTotal));
  const rows: Button[][] = [];
  if (order.status === 'ASSEMBLING') {
    if (item.status === 'PENDING') {
      if (canQuickConfirm(order, item))
        rows.push([{ text: '✅ По заказу', callback_data: staffData(order.id, 'a', item.id) }]);
      rows.push([{ text: item.unit === 'GRAM' ? '⚖️ Ввести вес' : '✏️ Изменить количество',
        callback_data: staffData(order.id, item.unit === 'GRAM' ? 'w' : 'q', item.id) }]);
      rows.push([{ text: '❌ Нет в наличии', callback_data: staffData(order.id, 'm', item.id) }]);
    } else rows.push([{ text: '↩️ Вернуть в сборку', callback_data: staffData(order.id, 'r', item.id) }]);
  }
  rows.push([{ text: '⬅️ К позициям', callback_data: staffData(order.id, 'i', 0) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function extraPage(order: OrderView): { text: string; keyboard: Keyboard } {
  const extras = order.extras.filter(extra => extra.status === 'ACTIVE').slice(0, 10);
  const rows: Button[][] = extras.flatMap(extra => [[
    { text: '✏️ ' + clean(extra.title, 30), callback_data: staffData(order.id, 'xe', extra.id) },
    { text: '❌', callback_data: staffData(order.id, 'xd', extra.id) },
  ]]);
  rows.push([{ text: '⬅️ Назад к заказу', callback_data: staffData(order.id, 'o') }]);
  return { text: 'Доп. позиции заказа #' + order.id + '\n' +
    extras.map(extra => clean(extra.title, 80) + ' · ' + extra.quantity + ' × ' +
      money(extra.unitPrice) + ' = ' + money(extra.amount)).join('\n'),
  keyboard: { inline_keyboard: rows } };
}
