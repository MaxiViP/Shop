import { short, webAppUrl } from './customer-view.js';
import { staffPageUrl } from './bot-config.js';

export function orderChatPath(order: number | string, staff: boolean, messageId?: number) {
  return `${staff ? '/staff/orders/' : '/order/'}${order}${messageId ? `?chatMessage=${messageId}` : ''}#order-chat`;
}

export function chatNotice(order: { id: number; publicId: string },
  message: { id: number; text: string }, staff: boolean, revision: boolean) {
  const path = orderChatPath(staff ? order.id : order.publicId, staff, message.id);
  const url = staff ? staffPageUrl(path) : webAppUrl(path);
  const heading = revision ? `${staff ? 'Покупатель' : 'Продавец'} отметил фото` :
    `Новое сообщение от ${staff ? 'покупателя' : 'продавца'}`;
  return {
    text: `${heading}\nЗаказ №${order.id}${revision ? '' : '\n\n' + (short(message.text, 240) || '📷 Фото по заказу')}`,
    reply_markup: { inline_keyboard: url ? [[{
      text: revision ? 'Посмотреть отметку' : 'Открыть чат',
      ...(staff ? { url } : { web_app: { url } }),
    }]] : [] },
    link_preview_options: { is_disabled: true },
  };
}
