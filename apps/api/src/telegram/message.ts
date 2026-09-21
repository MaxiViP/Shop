import type { Prisma, Unit } from '../db/gen/client.js';

export const telegramOrderSelect = {
  id: true, status: true, type: true, customerName: true, customerPhone: true,
  city: true, street: true, house: true, flat: true, entrance: true,
  floor: true, intercom: true, comment: true, deliveryAt: true,
  subtotal: true, deliveryPrice: true, total: true,
  items: {
    orderBy: { id: 'asc' },
    select: { productName: true, unit: true, qty: true, total: true },
  },
} as const satisfies Prisma.OrderSelect;

export type TelegramOrder = Prisma.OrderGetPayload<{ select: typeof telegramOrderSelect }>;

function clip(value: string, limit: number) {
  // eslint-disable-next-line no-control-regex -- Strip control characters from untrusted notification text.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text
    : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

function money(value: number) {
  return (value / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
}

function quantity(qty: number, unit: Unit) {
  if (unit === 'GRAM') return qty >= 1000
    ? (qty / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 }) + ' кг'
    : qty + ' г';
  if (unit === 'BUNCH') {
    const last = qty % 10;
    const teen = qty % 100 >= 11 && qty % 100 <= 14;
    return qty + ' ' + (teen ? 'пучков' : last === 1 ? 'пучок' : last >= 2 && last <= 4 ? 'пучка' : 'пучков');
  }
  return qty + (unit === 'PACK' ? ' уп.' : ' шт.');
}

export function newOrderMessage(order: TelegramOrder): string {
  const header = [
    'Новый заказ #' + order.id, '',
    clip(order.customerName, 100), clip(order.customerPhone, 40), '',
    order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка',
  ];
  if (order.type === 'DELIVERY') {
    const address = [order.city, order.street, order.house].filter(Boolean)
      .map(value => clip(value!, 150)).join(', ');
    if (address) header.push(address);
    for (const [label, value] of [
      ['Кв.', order.flat], ['Подъезд', order.entrance],
      ['Этаж', order.floor], ['Домофон', order.intercom],
    ]) {
      if (value?.trim()) header.push(label + ': ' + clip(value, 60));
    }
  }
  if (order.deliveryAt) header.push('Желаемое время (Москва): ' +
    order.deliveryAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }));

  const footer = [
    '', 'Товары: ' + money(order.subtotal),
    'Доставка: ' + (order.deliveryPrice === null ? 'рассчитывается' : money(order.deliveryPrice)),
    'Итого: ' + (order.total === null ? 'уточняется' : money(order.total)),
  ];
  if (order.comment?.trim()) footer.push('', 'Комментарий:', clip(order.comment, 500));
  const tail = footer.join('\n');
  let text = header.join('\n') + '\n\nТовары:\n';
  let shown = 0;
  for (const item of order.items) {
    const line = '• ' + clip(item.productName, 180) + ' — ' + quantity(item.qty, item.unit) +
      '\n  ' + money(item.total) + '\n';
    // Reserve room for totals/comment and the omitted-items count; never split a surrogate pair.
    if (text.length + line.length + tail.length + 80 > 4000) break;
    text += line;
    shown++;
  }
  if (shown < order.items.length) text += '…и ещё ' + (order.items.length - shown) + ' позиций\n';
  return text + tail;
}
