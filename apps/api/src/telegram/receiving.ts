import { z } from 'zod';
import type { Address, CustomerTelegramSession } from '../db/gen/client.js';
import { addressSchema } from '../order/schema.js';
import { addressLines, short, date, type Button, type Screen } from './customer-view.js';
import { checkoutPrompts } from './checkout.js';
import { shoppingData } from './shopping-callback.js';
import { pageInfo } from './page.js';

export const receivingPayload = z.object({
  purpose: z.literal('RECEIVING').default('RECEIVING'),
  stage: z.enum(['TYPE', 'ADDRESS', 'VIEW', 'CITY', 'STREET', 'HOUSE', 'FLAT', 'ENTRANCE', 'FLOOR', 'INTERCOM', 'COMMENT', 'REVIEW', 'DONE']).default('TYPE'),
  type: z.enum(['PICKUP', 'DELIVERY']).optional(),
  address: addressSchema.partial().optional(),
  addressId: z.number().int().positive().optional(),
  addressUpdatedAt: z.string().datetime().optional(),
  page: z.number().int().min(0).max(10000).default(0),
});
export type ReceivingPayload = z.infer<typeof receivingPayload>;
export function isReceiving(session: Pick<CustomerTelegramSession, 'action' | 'payload'>) {
  return session.action === 'CHECKOUT' && session.payload !== null && typeof session.payload === 'object' &&
    !Array.isArray(session.payload) && session.payload.purpose === 'RECEIVING';
}
export function receivingScreen(session: CustomerTelegramSession, addresses: Address[], total: number): Screen | { prompt: string } {
  const data = receivingPayload.parse(session.payload);
  const step = data.stage;
  const choose = (text: string, choice: string, value?: number): Button => ({ text,
    callback_data: shoppingData('g', session.id, choice, ...(value === undefined ? [] : [value])) });
  const navigation: Button[][] = [[{ text: '← Меню', callback_data: 'menu' }, { text: '🛒 Корзина', callback_data: 'cart' }]];
  if (step === 'TYPE') return {
    text: '🚚 Доставка и самовывоз\n\nВыберите способ получения для следующего заказа.\nЗаказ будет создан только после проверки корзины и подтверждения.' +
      (addresses[0] ? '\n\nСохранённый адрес:\n' + addressLines(addresses[0]).join('\n') : '\n\nСохранённых адресов пока нет.'),
    keyboard: { inline_keyboard: [[choose('🛍 Самовывоз', 'pickup'), choose('🚚 Доставка', 'delivery')], ...navigation] },
  };
  if (step === 'ADDRESS') {
    const info = pageInfo(total, data.page, 6);
    return { text: '📍 Сохранённые адреса' + (info.pages > 1 ? '\n' + info.label : '') +
      (addresses.length ? '\n\nВыберите адрес, чтобы посмотреть или изменить его.' : '\n\nДобавьте адрес доставки.'),
      keyboard: { inline_keyboard: [
        ...addresses.map(address => [choose((address.isDefault ? '⭐ ' : '') + short(address.label, 24) + ' · ' +
          short([address.city, address.street, address.house].join(', '), 100), 'view', address.id)]),
        ...(info.pages > 1 ? [[...(info.page ? [choose('← Адреса', 'page', info.page - 1)] : []),
          ...(info.page + 1 < info.pages ? [choose('Адреса →', 'page', info.page + 1)] : [])]] : []),
        [choose('＋ Новый адрес', 'new')], [choose('🛍 Выбрать самовывоз', 'pickup')], ...navigation,
      ] } };
  }
  if (step === 'VIEW' || step === 'REVIEW') return {
    text: (step === 'VIEW' ? '📍 Адрес доставки' : '📍 Проверьте адрес') + '\n\n' + addressLines(data.address ?? {}).join('\n'),
    keyboard: { inline_keyboard: [
      [choose(step === 'VIEW' ? '✅ Использовать этот адрес' : '✅ Сохранить адрес', step === 'VIEW' ? 'use' : 'save')],
      [choose('✏️ Изменить адрес', 'edit'), choose('← Адреса', 'page', data.page)], ...navigation,
    ] },
  };
  if (step === 'DONE') return {
    text: '🚚 Получение следующего заказа\n\n' + (data.type === 'PICKUP' ? '🛍 Выбран самовывоз.' :
      '🚚 Выбрана доставка.\n' + addressLines(data.address ?? {}).join('\n')) +
      '\n\nВыбор действует до ' + date(session.expiresAt) + ' МСК (30 минут после подтверждения).' + (data.type === 'DELIVERY' ? ' Адрес сохранён в вашем профиле.' : '') +
      ' При оформлении проверьте получение и стоимость доставки.\nЗаказ ещё не создан.',
    keyboard: { inline_keyboard: [[choose('🛍 Самовывоз', 'pickup'), choose('🚚 Доставка', 'delivery')], ...navigation] },
  };
  const prompt = checkoutPrompts[step as keyof typeof checkoutPrompts];
  if (!prompt) throw new Error('INVALID_RECEIVING_STEP');
  return session.promptMessageId ? { text: 'Ответьте на последнее приглашение. /resume — продолжить ввод адреса.',
    keyboard: { inline_keyboard: [[{ text: 'Продолжить ввод', callback_data: 'resume' }], ...navigation] } } :
    { prompt: 'Адрес доставки\n' + prompt + '\nОтветьте на это сообщение. /resume — продолжить; /cancel — отменить ввод.' };
}
