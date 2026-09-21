import { newOrderMessage, type TelegramOrder } from './message.js';

const order: TelegramOrder = {
  id: 154, status: 'NEW', type: 'DELIVERY', customerName: 'Максим <&_*[]>', customerPhone: '+70000000000',
  city: 'Москва', street: 'Рыночная', house: '1', flat: '2', entrance: '3',
  floor: '4', intercom: '5', comment: 'Позвонить <before> & [arrival]',
  deliveryAt: null, subtotal: 69000, deliveryPrice: null, total: null,
  items: [{ productName: 'Томаты', unit: 'GRAM', qty: 1000, total: 45000 }],
};

describe('Telegram new order text', () => {
  it('uses saved money, optional address details and plain user text', () => {
    const text = newOrderMessage(order);
    for (const part of ['Новый заказ #154', order.customerName, order.comment!,
      'Москва, Рыночная, 1', 'Кв.: 2', 'Подъезд: 3', 'Этаж: 4', 'Домофон: 5',
      'Томаты — 1 кг', '450 ₽', 'Товары: 690 ₽', 'Доставка: рассчитывается', 'Итого: уточняется']) {
      expect(text).toContain(part);
    }
    expect(text).not.toMatch(/null|undefined|45000 ₽/);
  });

  it('omits delivery address for pickup and displays stored totals, not computed totals', () => {
    const text = newOrderMessage({ ...order, type: 'PICKUP', comment: null, total: 12345, deliveryPrice: 0 });
    expect(text).toContain('Самовывоз');
    expect(text).toContain('Итого: 123,45 ₽');
    expect(text).toContain('Доставка: 0 ₽');
    for (const part of ['Рыночная', 'Кв.:', 'Подъезд:', 'Этаж:', 'Домофон:', 'Комментарий:'])
      expect(text).not.toContain(part);
  });

  it.each([
    ['GRAM', 500, '500 г'], ['GRAM', 1000, '1 кг'], ['GRAM', 1500, '1,5 кг'],
    ['GRAM', 1001, '1,001 кг'], ['PIECE', 2, '2 шт.'], ['PACK', 2, '2 уп.'],
    ['BUNCH', 1, '1 пучок'], ['BUNCH', 2, '2 пучка'], ['BUNCH', 5, '5 пучков'],
    ['BUNCH', 12, '12 пучков'], ['BUNCH', 21, '21 пучок'], ['BUNCH', 22, '22 пучка'],
  ] as const)('formats %s %i as %s', (unit, qty, expected) => {
    expect(newOrderMessage({ ...order, items: [{ productName: 'Товар', unit, qty, total: 12345 }] }))
      .toContain('Товар — ' + expected + '\n  123,45 ₽');
  });

  it('omits absent fields and labels requested time explicitly in Moscow', () => {
    const text = newOrderMessage({ ...order, flat: null, entrance: '', floor: null, intercom: null,
      comment: null, deliveryAt: new Date('2026-09-21T09:00:00Z') });
    expect(text).toContain('Желаемое время (Москва): 21.09.2026, 12:00:00');
    expect(text).not.toMatch(/Кв.:|Подъезд:|Этаж:|Домофон:|Комментарий:|null|undefined/);
  });

  it('bounds large Unicode orders while keeping totals and omitted count', () => {
    const long = 'ἴe'.repeat(10000);
    const text = newOrderMessage({ ...order, customerName: long, city: long, street: long, house: long,
      flat: long, entrance: long, floor: long, intercom: long, comment: long,
      items: Array.from({ length: 1000 }, () => ({ productName: long, unit: 'GRAM', qty: 1500, total: 12345 })) });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.isWellFormed()).toBe(true);
    expect(text).toMatch(/…и ещё \d+ позиций/);
    expect(text).toContain('Товары: 690 ₽');
    expect(text).toContain('Итого: уточняется');
  });
});
