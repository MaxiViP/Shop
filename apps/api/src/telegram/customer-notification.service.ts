import { Injectable } from '@nestjs/common';
import type { OrderNotification, OrderIssue, DeliveryStatus } from '../db/gen/client.js';
import { botDelivery } from './bot-api.js';
import { customerBotToken, customerWebhookReady } from './bot-config.js';
import { customerView } from './customer-callback.js';
import { amount, short, webAppUrl, deliveryStatus, type Button } from './customer-view.js';

export type CustomerNotice = {
  event: Pick<OrderNotification, 'type'>;
  order: { id: number; publicId: string; finalSubtotal: number | null; finalTotal: number | null; delivery: { status: DeliveryStatus } | null };
  issue: Pick<OrderIssue, 'type'> | null;
  message: { text: string } | null;
};
@Injectable()
export class CustomerNotificationService {
  get available() { return Boolean(customerBotToken()) && customerWebhookReady(); }

  async send(chatId: string, notice: CustomerNotice) {
    const { event, order, issue, message } = notice;
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
    };
    const text = 'Заказ №' + order.id + '\n' + headings[event.type] +
      (event.type === 'PAYMENT_READY' ? '\nТовары: ' + amount(order.finalSubtotal) + '\nИтого: ' + amount(order.finalTotal) : '') +
      (event.type === 'CHAT_MESSAGE' && message ? '\n\n' + message.text :
        event.type === 'ACTION_REQUIRED' ? '\nОткройте вопрос, чтобы проверить товар и выбрать действие.' : '');
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
