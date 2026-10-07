import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { preorderLabel } from '../app/utils/preorder.ts';
import { compareQueue } from '../app/utils/queue.ts';

test('closed-market customer labels use the server Moscow day, not the browser timezone or a hardcoded tomorrow', () => {
  const market = { isOpen: false, today: '2026-10-07', nextOpenAt: '2026-10-08T06:00:00.000Z' };
  assert.match(preorderLabel({ market, preparationStartsAt: '2026-10-08T06:00:00.000Z' }), /завтра после 09:00/);
  assert.match(preorderLabel({ market, preparationStartsAt: '2026-10-07T06:00:00.000Z' }), /сегодня после 09:00/);
  assert.match(preorderLabel({ market, preparationStartsAt: '2026-10-10T06:00:00.000Z' }), /10 октября после 09:00/);
  assert.match(preorderLabel({ market: { ...market, isOpen: true }, preparationStartsAt: '2026-10-08T06:00:00.000Z' }), /Сегодня уже не успеем/);
});

test('staff queue keeps active work first and ranks nearer future preorders above later ones', () => {
  const base = { type: 'PICKUP', deliveryAt: null, createdAt: '2026-10-07T19:30:00.000Z', status: 'NEW', queueRank: null };
  const rows = [
    { ...base, id: 3, scheduledFor: '2026-10-09T07:00:00.000Z' },
    { ...base, id: 2, scheduledFor: '2026-10-08T07:00:00.000Z' },
    { ...base, id: 1, status: 'ASSEMBLING', scheduledFor: null },
  ];
  assert.deepEqual(rows.sort(compareQueue).map(row => row.id), [1, 2, 3]);
});

test('customer and staff display preorders, and refreshing offers never overwrites an explicit future selection', async () => {
  const root = new URL('../app/', import.meta.url);
  const [cart, staff, order, status] = await Promise.all([
    'pages/cart.vue', 'pages/staff/orders/index.vue', 'pages/order/[id].vue', 'components/app/ShopStatus.vue',
  ].map(file => readFile(new URL(file, root), 'utf8')));
  assert.match(cart, /if \(form.pickupTiming === 'scheduled' && form.pickupAt\) \{/);
  assert.match(cart, /preorderLabel\(queueOffer\)/);
  assert.ok(!cart.includes('Заказы сейчас недоступны'));
  assert.match(staff, /Предзаказ · к/);
  assert.match(order, /Предзаказ · подготовим к/);
  assert.match(status, /Предзаказы принимаются/);
});
