import { bold, marked, heading, paragraph, richTable, type InputRichMessage, type RichText } from './rich.js';
import type { OrderStatus, OrderType, PaymentStatus } from '../db/gen/client.js';
import { payableGoods } from '../promo/promo.js';

type Summary = {
  status: OrderStatus; type: OrderType; subtotal: number | null; total: number | null;
  finalSubtotal: number | null; finalTotal: number | null; deliveryPrice: number | null;
  promoDiscount?: number; finalPromoDiscount?: number | null; promoCodeSnapshot?: string | null;
  payment: { status: PaymentStatus; amount: number } | null;
  items: { status: string }[]; issues: { status: string }[];
  extras: { status?: string; amount: number }[];
};
const money = (value: number | null | undefined) => value == null ? 'уточняется' :
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value / 100) + ' ₽';
export function progressLabel(order: Pick<Summary, 'items' | 'issues'>): string {
  const picked = order.items.filter(item => item.status === 'PICKED').length;
  const complete = order.items.length > 0 && picked === order.items.length && !order.issues.some(issue => ['WAITING_CUSTOMER', 'WAITING_SELLER'].includes(issue.status));
  return (complete ? '✅ ' : '🧺 ') + 'Собрано: ' + picked + ' из ' + order.items.length;
}
export function paymentLabel(payment: Summary['payment']): string {
  if (!payment) return 'Оплата — после сборки';
  return { PAID: '✅ Оплата получена', REPORTED: '⚠️ Требуется проверить оплату', AWAITING: '⏳ Ожидаем оплату', CANCELED: '❌ Оплата отменена' }[payment.status];
}
export function orderRich(order: Summary, content: { title: string; person: string; next: string; details: string[]; items: string[]; sellerActions?: number }): InputRichMessage {
  const financial: [string, string][] = [
    ['Товары при заказе', money(order.subtotal)], ['Запрошено при заказе', money(order.total)],
    ['Факт товаров и доп. позиций', money(order.finalSubtotal)],
    ['Скидка при заказе', money(order.promoDiscount)], ['Итоговая скидка', money(order.finalPromoDiscount)],
    ['Доставка', money(order.deliveryPrice)],
  ];
  const extras = order.extras.filter(extra => extra.status === undefined || extra.status === 'ACTIVE');
  if (extras.length) financial.push(['Доп. позиции (включены в факт)', money(extras.reduce((sum, extra) => sum + extra.amount, 0))]);
  if (order.promoCodeSnapshot) financial.push(['Промокод', order.promoCodeSnapshot]);
  if (order.payment) financial.push([order.payment.status === 'PAID' ? 'Подтверждено за товары' : 'Сумма платежа за товары', money(order.payment.amount)]);
  const due = order.finalSubtotal == null ? null : payableGoods(order);
  const mismatch = order.payment && Number.isSafeInteger(order.payment.amount) && due != null && order.payment.amount !== due;
  const waiting = order.status === 'ASSEMBLING' ? order.issues.filter(issue => issue.status === 'WAITING_CUSTOMER').length : 0;
  const seller = order.status === 'ASSEMBLING' ? content.sellerActions ?? order.issues.filter(issue => issue.status === 'WAITING_SELLER').length : 0;
  return { blocks: [heading(content.title),
    paragraph([bold(order.type === 'PICKUP' ? '🛍 Самовывоз' : '🚚 Доставка'), ...(content.person ? [' · ' + content.person] : [])]),
    heading(order.finalTotal != null ? 'ИТОГО: ' + money(order.finalTotal) : 'Предварительно: ' + (order.total == null ? 'уточняется' : '≈ ' + money(order.total))),
    paragraph([bold(paymentLabel(order.payment)), '\n', bold(progressLabel(order))]),
    ...(order.payment ? [paragraph((order.payment.status === 'PAID' ? 'Подтверждено за товары: ' : 'К оплате за товары: ') + money(order.payment.amount))] : []),
    ...(mismatch ? [paragraph(marked('⚠️ Сумма платежа отличается от итоговой стоимости товаров: ' + money(order.payment!.amount) + ' / ' + money(due)))] : []),
    paragraph(marked(content.next)),
    ...(waiting || seller ? [paragraph(bold('Требуется решение: покупателю ' + waiting + ' · продавцу ' + seller))] : []),
    { type: 'divider' },
    { type: 'details', summary: 'Расчёт · товары, скидки, доставка', blocks: [richTable(financial)] },
    ...(content.details.length ? [{ type: 'details' as const, summary: 'Получение и контакты', blocks: [paragraph(content.details.join('\n'))] }] : []),
    { type: 'details', summary: 'Товары и дополнительные позиции · ' + order.items.length, blocks: content.items.length ? content.items.map(paragraph) : [paragraph('Позиций нет.')] },
  ] };
}
export function orderFallback(lines: string[], primary: string[]): RichText[] {
  const main = new Set(primary);
  return lines.map(line => main.has(line) ? bold(line) : line);
}
