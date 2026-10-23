import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { orderCard, type CustomerOrder } from './customer-view.js';
import { dashboard, type OrderView } from './staff-bot-view.js';
import { fallbackHtml, richMessage, validScreen } from './rich.js';

const item = { id: 1, productName: 'Слива <фермерская>', qty: 500, actualQty: 500, unit: 'GRAM', price: 280100, priceQty: 1000,
  total: 140050, actualTotal: 140050, actualPrice: null, status: 'PICKED' };
const order = { id: 9, publicId: '11111111-1111-4111-8111-111111111111', status: 'READY', type: 'PICKUP',
  customerName: 'Покупатель <Анна & Иван>', customerPhone: '+79000000000', createdAt: new Date('2026-10-23T08:00:00Z'),
  assemblyFinalizedAt: new Date('2026-10-23T09:00:00Z'), subtotal: 280100, total: 280100, finalSubtotal: 280100,
  finalTotal: 280100, promoDiscount: 0, finalPromoDiscount: 0, deliveryPrice: 0, promoCodeSnapshot: null,
  city: 'Москва', street: 'Тестовая', house: '1', customerUnread: 0, delivery: null, comment: null,
  payment: { status: 'PAID', amount: 280100 }, items: [item, { ...item, id: 2 }], issues: [], extras: [] } as unknown as CustomerOrder;
const scenarios = [
  { id: 'pickup-paid', order },
  { id: 'delivery-paid', order: { ...order, type: 'DELIVERY', deliveryPrice: 30000, finalTotal: 310100,
    delivery: { status: 'ASSIGNED', provider: 'OTHER', courierName: 'Тестовый курьер', courierPhone: '+79000000001' } } as CustomerOrder },
  { id: 'awaiting', order: { ...order, payment: { ...order.payment!, status: 'AWAITING' } } },
  { id: 'reported', order: { ...order, payment: { ...order.payment!, status: 'REPORTED' } } },
  { id: 'partial', order: { ...order, status: 'ASSEMBLING', assemblyFinalizedAt: null, finalTotal: null, finalSubtotal: null, payment: null,
    items: [order.items[0]!, { ...order.items[1]!, status: 'PENDING', actualQty: null, actualTotal: null }] } as CustomerOrder },
];

it.each(scenarios)('renders explicit semantic blocks for $id, preserving limits and escaped fallback', ({ order }) => {
  for (const screen of [orderCard(order), dashboard(order as unknown as OrderView)]) {
    expect(validScreen(screen)).toBe(true);
    const blocks = richMessage(screen).blocks;
    expect(blocks[0]).toMatchObject({ type: 'heading' });
    expect(blocks.some(block => block.type === 'divider')).toBe(true);
    expect(blocks.some(block => block.type === 'details')).toBe(true);
    expect(JSON.stringify(blocks)).toContain('"type":"marked"');
    const fallback = fallbackHtml(screen.text, screen.fallback);
    expect(fallback).toMatch(/<b>.*(?:Самовывоз|Доставка).*<\/b>/);
    expect(fallback).not.toContain('<Анна');
    if (order.finalTotal !== null) expect(fallback).toMatch(/<b>Итого: /);
    if (order.payment?.status === 'PAID') expect(JSON.stringify(blocks)).toContain('✅ Оплата получена');
    else expect(JSON.stringify(blocks)).not.toContain('✅ Оплата получена');
    if (order.status === 'ASSEMBLING') {
      expect(JSON.stringify(blocks)).toContain('🧺 Собрано: 1 из 2');
      expect(JSON.stringify(blocks)).not.toContain('✅ Собрано:');
    }
  }
});

it('keeps unknown totals unknown, discounts/extras separate, and warns about a payment mismatch', () => {
  const changed = { ...order, type: 'DELIVERY', total: null, deliveryPrice: null, finalTotal: null,
    finalSubtotal: 300000, finalPromoDiscount: 10000,
    payment: { ...order.payment!, amount: 280100, status: 'REPORTED' },
    extras: [{ id: 3, title: 'Упаковка', quantity: 1, unitPrice: 19900, amount: 19900, comment: null }] } as CustomerOrder;
  const data = JSON.stringify(richMessage(orderCard(changed)));
  expect(data).toContain('Сумма платежа отличается');
  expect(data).toContain('Предварительно: уточняется');
  expect(data).toContain('Доп. позиции (включены в факт)');
  expect(data).toContain('Итоговая скидка');
  expect(data).not.toContain('✅ Оплата получена');
});
it('does not call missing goods or pending decisions completed assembly', () => {
  for (const changed of [
    { ...order, items: [{ ...order.items[0]!, status: 'MISSING' }] },
    { ...order, issues: [{ status: 'WAITING_CUSTOMER' }] },
    { ...order, payment: { ...order.payment!, status: 'CANCELED' } },
  ]) {
    const data = JSON.stringify(richMessage(orderCard(changed as CustomerOrder)));
    if (changed.payment?.status === 'CANCELED') expect(data).toContain('❌ Оплата отменена');
    else expect(data).not.toContain('✅ Собрано:');
  }
});
it('bounds long names and large order pages in both representations', () => {
  const huge = { ...order, customerName: 'Я'.repeat(2000), comment: '<script>'.repeat(1000),
    items: Array.from({ length: 1000 }, (_, id) => ({ ...order.items[0]!, id: id + 1, productName: '<x>'.repeat(1000) })) };
  for (const screen of [orderCard(huge), dashboard(huge as unknown as OrderView)]) expect(validScreen(screen)).toBe(true);
});
it('exports examples from production renderers for real client review', () => {
  const screens = scenarios.flatMap(({ id, order }) => [
    { id: 'customer-' + id, ...orderCard(order) }, { id: 'staff-' + id, ...dashboard(order as unknown as OrderView) },
  ]).map(screen => ({ ...screen, rich_message: richMessage(screen), html: fallbackHtml(screen.text, screen.fallback) }));
  if (process.env.TELEGRAM_COMPACT_SNAPSHOTS === '1') writeFileSync(resolve('../../work/telegram-ux2-compact/orders.json'), JSON.stringify(screens, null, 2));
  expect(screens).toHaveLength(10);
});
