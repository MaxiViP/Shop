import type { AdminChange } from '../db/gen/client.js';

export const activityEntities: Record<string, string> = {
  User: 'Пользователь',
  MarketPointOwner: 'Права на торговую точку',
  Product: 'Товар',
  ProductImage: 'Фото товара',
  Category: 'Категория',
  MarketPoint: 'Торговая точка',
  MarketLayout: 'Карта рынка',
  SeasonTemplate: 'Сезон',
  HomeSlide: 'Слайд главной',
  ShopSettings: 'Настройки магазина',
  ShopHours: 'Режим работы',
  ShopHoursException: 'Исключение расписания',
  PromoCode: 'Промокод',
  PartnerPayout: 'Выплата',
  Order: 'Заказ',
  OrderItem: 'Позиция заказа',
  OrderPayment: 'Оплата',
  OrderExtra: 'Доплата',
  OrderCancellation: 'Отмена заказа',
  OrderIssue: 'Согласование',
  OrderItemPriceChange: 'Цена позиции',
  Delivery: 'Доставка',
  DeliveryAttempt: 'Заявка доставки',
  OrderChatMessage: 'Сообщение по заказу',
  OrderChatImageRevision: 'Фото по заказу',
};
const operations: Record<string, string> = {
  INSERT: 'Создано',
  UPDATE: 'Изменено',
  DELETE: 'Удалено',
};
const fields: Record<string, string> = {
  name: 'Название',
  price: 'Цена в коп.',
  active: 'Активен',
  role: 'Роль',
  status: 'Статус',
  serviceMarkupPercent: 'Наценка, %',
  quantity: 'Количество',
  qty: 'Количество',
  actualQty: 'Собрано',
  amount: 'Сумма в коп.',
  total: 'Итого в коп.',
  finalTotal: 'Итого в коп.',
  title: 'Заголовок',
  text: 'Текст',
  adminPasswordChanged: 'Пароль изменён',
};
const brief = (value: unknown) => {
  const text =
    typeof value === 'string' ? value : (JSON.stringify(value) ?? '—');
  return text.length > 100 ? text.slice(0, 97) + '…' : text;
};
export function activityText(events: AdminChange[]): string {
  const first = events[0];
  if (!first) return '';
  const lines = [
    'Изменения администратора',
    first.actorName + ' · #' + first.actorId,
    (first.source === 'TELEGRAM' ? 'Telegram' : 'Админка сайта') +
      ' · ' +
      first.createdAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    'Изменений: ' + events.length,
    '',
  ];
  for (const event of events.slice(0, 5)) {
    lines.push(
      `${operations[event.operation] ?? event.operation}: ${activityEntities[event.entity] ?? event.entity} #${event.entityId}`,
    );
    const after = event.afterValue;
    const before = event.beforeValue;
    if (after && typeof after === 'object' && !Array.isArray(after)) {
      for (const [key, value] of Object.entries(after).slice(0, 6)) {
        const old =
          before && typeof before === 'object' && !Array.isArray(before)
            ? before[key]
            : undefined;
        lines.push(
          `${fields[key] ?? key}: ${old === undefined ? '' : brief(old) + ' → '}${brief(value)}`,
        );
      }
    }
    lines.push('');
  }
  if (events.length > 5) lines.push(`Ещё изменений: ${events.length - 5}`);
  const footer = ['Запись №' + first.id];
  const origin = process.env.ORDER_SITE_URL;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === 'https:' && !url.username && !url.password)
        footer.push(url.origin + '/admin/activity');
    } catch {
      /* The journal remains accessible through the admin navigation. */
    }
  }
  return lines.join('\n').slice(0, 3300) + '\n\n' + footer.join('\n');
}
