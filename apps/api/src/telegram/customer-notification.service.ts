import { Injectable } from '@nestjs/common';
import type { OrderNotification, OrderIssue, DeliveryStatus } from '../db/gen/client.js';
import { botDelivery } from './bot-api.js';
import { customerBotToken, customerWebhookReady } from './bot-config.js';
import { customerView } from './customer-callback.js';
import { amount, short, webAppUrl, deliveryStatus, type Button } from './customer-view.js';
import { chatNotice } from './chat-notice.js';

export type CustomerNotice = {
  event: Pick<OrderNotification, 'type'>;
  order: { id: number; publicId: string; finalSubtotal: number | null; finalTotal: number | null; delivery: { status: DeliveryStatus } | null };
  issue: Pick<OrderIssue, 'type'> | null;
  message: { id?: number; text: string } | null;
  queue?: { position: number | null; wait: { min: number; max: number } | null } | null;
};
@Injectable()
export class CustomerNotificationService {
  get available() { return Boolean(customerBotToken()) && customerWebhookReady(); }

  async send(chatId: string, notice: CustomerNotice) {
    const { event, order, issue, message, queue } = notice;
    if (message?.id && ['CHAT_MESSAGE', 'CHAT_IMAGE_REVISION'].includes(event.type))
      return botDelivery(customerBotToken(), { chat_id: chatId,
        ...chatNotice(order, { id: message.id, text: message.text }, false, event.type === 'CHAT_IMAGE_REVISION') });
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
    };
    const text = 'Заказ №' + order.id + '\n' + headings[event.type] +
      (event.type === 'PAYMENT_READY' ? '\nТовары: ' + amount(order.finalSubtotal) + '\nИтого: ' + amount(order.finalTotal) : '') +
      (event.type === 'QUEUE_DELAY' ?
        `\n${queue?.position ? `Вы примерно ${queue.position}-й в очереди.\n` : ''}` +
        `${queue?.wait ? `Ориентировочное начало сборки через ${queue.wait.min}–${queue.wait.max} мин.\n` : ''}` +
        'Можно подождать или выбрать удобное время в заказе.' :
        event.type === 'ASSEMBLY_SOON' ? '\nПроверьте заказ: сборка начнётся в ближайшее время.' :
        event.type === 'CHAT_MESSAGE' && message ? '\n\n' + (message.text || '📷 Фото по заказу') :
        event.type === 'ACTION_REQUIRED' ? '\n\n' + (message?.text ?? 'Откройте вопрос, чтобы проверить товар и выбрать действие.') : '');
    const url = webAppUrl('/order/' + order.publicId);
    const rows: Button[][] = [
      [{ text: event.type === 'ACTION_REQUIRED' ? '❗ Ответить на вопрос' :
        event.type === 'CHAT_MESSAGE' ? '💬 Открыть сообщения' : 'Посмотреть заказ',
        callback_data: customerView(event.type === 'ACTION_REQUIRED' ? 'q' : event.type === 'CHAT_MESSAGE' ? 'm' : 'o', order.publicId) }],
      ...(url ? [[{ text: 'Открыть заказ на сайте', web_app: { url } }]] : []),
    ];
    return botDelivery(customerBotToken(), {
      chat_id: chatId, text: short(text, 3900).replaceAll('  ', ' '),
      // Retain line breaks and full chat text within the domain's 2,000-character bound.
      ...(text.length <= 3900 ? { text } : {}),
      reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true },
    });
  }
}
