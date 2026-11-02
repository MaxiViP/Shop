import type { OrderView } from './staff-bot-view.js';
import { dashboard, itemView, assemblyView, issuePage, workOverview, queueOrderButton } from './staff-bot-view.js';
import { staffCommands, staffCommand } from './staff-commands.js';
import { parseStaffAction, staffOrderCommand } from './staff-bot.js';
import { customerScreen as alignedScreen, richMessage, fallbackHtml, validScreen } from './rich.js';
import { orderRich } from './order-rich.js';

const order = { id: 125, type: 'PICKUP', status: 'ASSEMBLING', customerName: 'Покупатель <x>', customerPhone: '+79990000001',
  createdAt: new Date('2026-10-23T21:35:00Z'), subtotal: 195099, total: 195099, finalSubtotal: null, finalTotal: null, deliveryPrice: 0,
  payment: null, delivery: null, assemblyFinalizedAt: null, issues: [], extras: [],
  items: [{ id: 1, productName: 'Очень длинное название 🥬 '.repeat(20), unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE',
    qty: 1000, actualQty: 1080, actualWeightGrams: null, price: 11000, priceQty: 1000, total: 11000, actualTotal: 11880, actualPrice: null, status: 'PICKED' },
  { id: 2, productName: 'Киви', unit: 'PIECE', priceUnit: 'PIECE', saleModel: 'PIECE_FIXED',
    qty: 2, actualQty: null, actualWeightGrams: null, price: 11000, priceQty: 1, total: 22000, actualTotal: null, actualPrice: null, status: 'PENDING' }],
} as unknown as OrderView;

it('shows overview counts once on seven queue buttons and never double-counts overlapping issue queues', () => {
  const view = workOverview({ new: 2, confirmed: 3, assembly: 4, ready: 5, delivery: 6, seller: 9, customer: 11 });
  expect(view.text).not.toMatch(/Новые:|В сборке:|Нужно вам:/);
  const buttons = view.keyboard.inline_keyboard.flat();
  expect(buttons.filter(button => 'callback_data' in button && button.callback_data.startsWith('sq:'))).toHaveLength(7);
  expect(buttons[0]).toEqual({ text: '❗ Нужно вам · 9', callback_data: 'sq:seller:0', style: 'primary' });
  expect(buttons).toContainEqual({ text: '📋 Все заказы · 20', callback_data: 'sq:all:0' });
});
it.each(['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELED'] as const)(
  'formats a stable %s queue entry with all money and Moscow midnight information on the button', status => {
    const button = queueOrderButton({ ...order, status });
    expect(button.text).toContain('№125'); expect(button.text).toContain('Предв. ≈1\u00a0950,99 ₽');
    expect(button.text).toContain('24.10, 00:35'); expect(button.text).toContain('🛍 Самовывоз');
    expect(button.text.length).toBeLessThanOrEqual(180);
    expect(parseStaffAction('callback_data' in button ? button.callback_data : '')).toEqual({ orderId: 125, action: 'o' });
  });
it('distinguishes final zero, unknown totals and preliminary amounts without UI price calculations', () => {
  expect(queueOrderButton({ ...order, total: null }).text).toContain('Сумма уточняется');
  expect(queueOrderButton({ ...order, finalTotal: 0 }).text).toContain('Итог 0 ₽');
  expect(queueOrderButton({ ...order, finalTotal: 280100, type: 'DELIVERY' }).text).toContain('Итог 2\u00a0801 ₽');
});
it.each(['AWAITING', 'REPORTED', 'PAID', 'CANCELED'] as const)('keeps %s payment truthful, separate from assembly and total in Rich/HTML', status => {
  const changed = { ...order, status: 'READY', assemblyFinalizedAt: new Date(), finalSubtotal: 280100, finalTotal: 280100,
    payment: { status, amount: 280100 } } as OrderView;
  const view = dashboard(changed), rich = richMessage(alignedScreen(view));
  expect(JSON.stringify(rich)).toContain('СОБРАНО: 1 ИЗ 2');
  expect(JSON.stringify(rich).includes('✅ ОПЛАТА ПОЛУЧЕНА')).toBe(status === 'PAID');
  expect(fallbackHtml(view.text, view.fallback).includes('✅ Оплата получена')).toBe(status === 'PAID');
  if (status === 'REPORTED' || status === 'AWAITING') expect(view.keyboard.inline_keyboard[0]![0]).toMatchObject({ text: '💳 Проверить оплату', style: 'primary' });
  for (const block of rich.blocks) if (block.type === 'buttons') expect(block.align).toBe('left');
  expect(view.text.match(/ИТОГО:/g)).toHaveLength(1);
});
it('keeps per-item requested/actual weights and server costs prominent, and preserves saved result Rich blocks', () => {
  const view = itemView(order, order.items[0]!);
  const blocks = richMessage(alignedScreen(view)).blocks;
  expect(blocks.some(block => block.type === 'table')).toBe(true);
  expect(JSON.stringify(blocks)).toContain('1,08 кг'); expect(JSON.stringify(blocks)).toContain('118,8 ₽');
  expect(JSON.stringify(blocks)).not.toContain('NaN');
  const next = assemblyView(order, undefined, 1, 1);
  expect(next.rich).toBeDefined(); expect(JSON.stringify(next.rich)).toContain('✅ Сохранено');
  expect(validScreen(alignedScreen(next))).toBe(true);
});
it('keeps accepted pending replacements actionable only on their real replacement item', () => {
  const changed = { ...order, issues: [{ id: 1, status: 'RESOLVED', resolution: 'ACCEPT_REPLACEMENT', orderItemId: 1, replacementItemId: 2,
    proposedName: 'Киви' }] } as OrderView;
  const view = issuePage(changed);
  expect(view.text).not.toContain('Киви');
  expect(view.keyboard.inline_keyboard[0]![0]).toMatchObject({ text: '✅ Замена одобрена: Киви', callback_data: 's:125:v:2', style: 'primary' });
  expect(dashboard(changed).keyboard.inline_keyboard[0]![0]).toMatchObject({ callback_data: 's:125:v:2', style: 'primary' });
});
it('keeps default CUSTOMER order rendering unchanged when STAFF presentation is requested separately', () => {
  const content = { title: 'Заказ №125', person: 'Покупатель', next: 'Далее', details: [], items: [] };
  const customer = orderRich(order, content), staff = orderRich(order, { ...content, audience: 'staff' });
  expect(JSON.stringify(customer)).toContain('🛍 Самовывоз'); expect(JSON.stringify(customer)).toContain('Предварительно:');
  expect(JSON.stringify(customer)).not.toContain('САМОВЫВОЗ'); expect(JSON.stringify(staff)).toContain('САМОВЫВОЗ');
});
it('publishes STAFF commands only and preserves explicit order-number parsing with bot suffixes', () => {
  expect(staffCommands.map(value => value.command)).toEqual(['start', 'work', 'orders', 'attention', 'waiting', 'resume', 'cancel', 'help']);
  expect(staffOrderCommand(staffCommand('/order@ShopStaff_bot 123'))).toBe(123);
  expect(staffCommand('/work@ShopStaff_bot')).toBe('/work');
});
