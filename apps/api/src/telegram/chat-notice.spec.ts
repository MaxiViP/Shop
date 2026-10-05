import { chatNotice, orderChatPath } from './chat-notice.js';

afterEach(() => vi.unstubAllEnvs());
it('links each bot to the exact message, keeping the current photo revision implicit', () => {
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  const order = { id: 21, publicId: '11111111-1111-4111-8111-111111111111' };
  const message = { id: 87, text: 'Что выбрать?\n' + 'Я'.repeat(400) };
  const staff = chatNotice(order, message, true, false);
  expect(staff.text).toContain('Новое сообщение от покупателя\nЗаказ №21');
  expect(staff.text.length).toBeLessThan(350);
  expect(staff.reply_markup.inline_keyboard[0]?.[0]).toMatchObject({ text: 'Открыть чат',
    url: 'https://shop.example/staff/orders/21?chatMessage=87#order-chat' });
  const revision = chatNotice(order, message, false, true);
  expect(revision.text).toBe('Продавец отметил фото\nЗаказ №21');
  expect(revision.reply_markup.inline_keyboard[0]?.[0]).toMatchObject({ text: 'Посмотреть отметку',
    web_app: { url: 'https://shop.example/telegram?returnTo=' + encodeURIComponent(`/order/${order.publicId}?chatMessage=87#order-chat`) } });
  expect(orderChatPath(21, true)).toBe('/staff/orders/21#order-chat');
});
