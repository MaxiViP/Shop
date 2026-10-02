import { compositionMoney } from '../order/coordination.js';
import { staffPageUrl } from './bot-config.js';

type PriceNotice = {
  orderId: number;
  previousPrice: number;
  newPrice: number;
  createdAt: Date;
  reason: string | null;
  item: { productName: string; productId: number | null };
  actor: { name: string | null; role: 'SELLER' | 'ADMIN' | 'USER' };
};
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 120);

export function staffPriceNotice(change: PriceNotice) {
  const difference = change.newPrice - change.previousPrice;
  const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
    .format(Math.abs(difference) / change.previousPrice * 100);
  const sign = difference > 0 ? '+' : '−';
  const orderUrl = staffPageUrl(`/staff/orders/${change.orderId}`);
  const productUrl = change.item.productId === null ? undefined :
    staffPageUrl(`/admin/products/${change.item.productId}`);
  const text = [
    `Изменена цена товара в заказе №${change.orderId}`,
    oneLine(change.item.productName),
    `Цена заказа: ${compositionMoney(change.previousPrice)}`,
    `Новая цена: ${compositionMoney(change.newPrice)}`,
    `Изменил: ${change.actor.role === 'ADMIN' ? 'администратор' : 'продавец'} ${oneLine(change.actor.name || '(имя не указано)')}`,
    `Разница: ${sign}${compositionMoney(Math.abs(difference))} (${sign}${percent}%)`,
    `Время: ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(change.createdAt)} МСК`,
    ...(change.reason ? [`Причина: ${oneLine(change.reason)}`] : []),
    ...(orderUrl ? [`Заказ: ${orderUrl}`] : []),
    ...(productUrl ? [`Карточка товара: ${productUrl}`] : []),
  ].join('\n');
  return { text, link_preview_options: { is_disabled: true } };
}
