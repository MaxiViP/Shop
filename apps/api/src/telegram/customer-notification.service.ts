import { Injectable } from '@nestjs/common';
import type { OrderNotification, OrderIssue, DeliveryStatus, OrderType, PaymentStatus } from '../db/gen/client.js';
import { botDelivery } from './bot-api.js';
import { customerBotToken, customerWebhookReady } from './bot-config.js';
import { customerView } from './customer-callback.js';
import { shoppingData } from './shopping-callback.js';
import { amount, short, webAppUrl, deliveryStatus, type Button } from './customer-view.js';
import { chatNotice } from './chat-notice.js';

export type CustomerNotice = {
  event: Pick<OrderNotification, 'type'>;
  order: { id: number; publicId: string; finalSubtotal: number | null; finalTotal: number | null;
    type?: OrderType; payment?: { amount: number; status: PaymentStatus } | null;
    delivery: { status: DeliveryStatus } | null;
    promoCodeSnapshot?: string | null; promoDiscount?: number; finalPromoDiscount?: number | null; deliveryPrice?: number | null };
  issue: Pick<OrderIssue, 'type'> | null;
  message: { id?: number; text: string } | null;
  queue?: { position: number | null; wait: { min: number; max: number } | null } | null;
};

export function customerNoticeScreen(notice: CustomerNotice) {
  const { event, order, issue, message, queue } = notice;
  if (message?.id && ['CHAT_MESSAGE', 'CHAT_IMAGE_REVISION'].includes(event.type))
    return chatNotice(order, { id: message.id, text: message.text }, false, event.type === 'CHAT_IMAGE_REVISION');
  const headings = {
    ORDER_CONFIRMED: 'Заказ подтверждён',
    ASSEMBLY_STARTED: 'Началась сборка заказа',
    ACTION_REQUIRED: issue?.type === 'REPLACEMENT' ? 'Продавец предлагает замену' : 'Требуется ваше решение',
    PAYMENT_READY: 'Заказ собран. Итоговая сумма готова',
    PAYMENT_RECEIVED: 'Оплата получена',
    DELIVERY_CHANGED: 'Доставка: ' + (order.delivery ? deliveryStatus[order.delivery.status] : 'статус обновлён'),
    ORDER_COMPLETED: 'Заказ завершён',
    ORDER_CANCELED: 'Заказ отменён',
    CHAT_MESSAGE: 'Новое сообщение от продавца',
    CHAT_IMAGE_REVISION: 'Продавец отметил фото',
    ITEM_PRICE_CHANGED: 'Цена товара изменена',
    QUEUE_DELAY: 'Сейчас высокая загрузка',
    ASSEMBLY_SOON: 'Скоро начнём сборку',
    ORDER_STATUS_CHANGED: 'Статус заказа изменён',
    SCHEDULE_CHANGED: 'Время подготовки изменено',
  };
  const lines = ['Заказ №' + order.id, headings[event.type]];
  if (event.type === 'PAYMENT_READY') lines.push(
    'Товары: ' + amount(order.finalSubtotal),
    ...(order.promoCodeSnapshot ? ['Промокод: ' + short(order.promoCodeSnapshot, 32) +
      ' · скидка ' + amount(order.finalPromoDiscount ?? order.promoDiscount ?? 0)] : []),
    'Доставка: ' + amount(order.deliveryPrice ?? null), 'Итого: ' + amount(order.finalTotal),
    ...(order.payment ? ['К переводу за товары: ' + amount(order.payment.amount)] : []),
    '', 'Откройте оплату и проверьте реквизиты этого заказа. Поступление денег подтвердит продавец.',
  );
  if (event.type === 'QUEUE_DELAY') lines.push('',
    ...(queue?.position ? ['Вы примерно ' + queue.position + '-й в очереди.'] : []),
    ...(queue?.wait ? ['Ориентировочное начало сборки через ' + queue.wait.min + '–' + queue.wait.max + ' мин.'] : []),
    'Можно подождать или выбрать удобное время в заказе.');
  else if (event.type === 'ASSEMBLY_SOON') lines.push('', 'Проверьте заказ: сборка начнётся в ближайшее время.');
  else if (event.type === 'CHAT_MESSAGE' && message) lines.push('', message.text || '📷 Фото по заказу');
  else if (event.type === 'ACTION_REQUIRED') lines.push('',
    message?.text ?? 'Откройте вопрос, чтобы проверить товар и выбрать действие.',
    '', 'В вопросе покажем фактический вес, стоимость и доступные варианты решения.');
  else if (event.type === 'ORDER_CONFIRMED') lines.push('', 'Сообщим, когда начнётся сборка. Проверить состав и данные получения можно в заказе.');
  else if (event.type === 'ASSEMBLY_STARTED') lines.push('', 'Проверяем наличие и фактический вес. Если потребуется ваше решение, пришлём отдельный вопрос.');
  else if (event.type === 'PAYMENT_RECEIVED') lines.push('',
    order.payment?.amount === 0 ? 'Перевод за товары не требуется.' : 'Оплата товаров учтена.',
    order.type === 'PICKUP' ? 'Данные самовывоза — в карточке заказа.' : 'Актуальные данные получения — в карточке заказа.');
  else if (event.type === 'ORDER_COMPLETED') lines.push('', 'Спасибо за заказ! Привычные продукты можно выбрать снова по текущим ценам. Перед оформлением вы проверите состав.');
  const url = webAppUrl('/order/' + order.publicId);
  const rows: Button[][] = [
    ...(event.type === 'PAYMENT_READY' ? [[{ text: '💳 Открыть оплату', style: 'primary' as const,
      callback_data: shoppingData('p', order.publicId, 'SBP') }]] : []),
    [{ text: event.type === 'ACTION_REQUIRED' ? '❗ Ответить на вопрос' :
      event.type === 'CHAT_MESSAGE' ? '💬 Открыть сообщения' : 'Посмотреть заказ',
      ...(event.type === 'ACTION_REQUIRED' ? { style: 'primary' as const } : {}),
      callback_data: customerView(event.type === 'ACTION_REQUIRED' ? 'q' : event.type === 'CHAT_MESSAGE' ? 'm' : 'o', order.publicId) }],
    ...(url ? [[{ text: 'Открыть заказ на сайте', web_app: { url } }]] : []),
  ];
  if (event.type === 'ORDER_COMPLETED') {
    const quick = webAppUrl('/quick-shop');
    if (quick) rows.unshift([{ text: '⚡ Быстрые покупки', web_app: { url: quick }, style: 'primary' }]);
  }
  const text = lines.join('\n');
  return { text: text.length <= 3900 ? text : short(text, 3900),
    reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } };
}

@Injectable()
export class CustomerNotificationService {
  get available() { return Boolean(customerBotToken()) && customerWebhookReady(); }
  send(chatId: string, notice: CustomerNotice) {
    return botDelivery(customerBotToken(), { chat_id: chatId, ...customerNoticeScreen(notice) });
  }
}
