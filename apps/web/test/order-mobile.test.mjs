import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { focusedAssemblyItem } from '../app/utils/assembly.ts';

const source = path => readFile(new URL(`../app/${path}`, import.meta.url), 'utf8');

test('assembly opens the first pending item, advances after a save, and allows manual inspection', () => {
  const items = [
    { id: 1, status: 'PICKED' },
    { id: 2, status: 'PENDING' },
    { id: 3, status: 'PENDING' },
  ];
  assert.equal(focusedAssemblyItem(items, true, null), 2);
  assert.equal(focusedAssemblyItem(items, true, 1), 1);
  assert.equal(focusedAssemblyItem(items, true, 'none'), null);
  assert.equal(focusedAssemblyItem(items, false, null), null);
  assert.equal(focusedAssemblyItem(items.map(item => item.id === 2 ? { ...item, status: 'PICKED' } : item), true, null), 3);
});

test('staff and customer section links have real targets and stay available on mobile', async () => {
  const [staff, customer, sections, coordination, chat, payment] = await Promise.all([
    source('pages/staff/orders/[id].vue'),
    source('pages/order/[id].vue'),
    source('components/order/Sections.vue'),
    source('components/order/Coordination.vue'),
    source('components/order/Chat.vue'),
    source('components/order/Payment.vue'),
  ]);
  for (const id of ['order-data', 'assembly', 'order-summary', 'delivery'])
    assert.match(staff, new RegExp(`id="${id}"`));
  for (const id of ['order-items', 'order-receiving', 'order-summary'])
    assert.match(customer, new RegExp(`id="${id}"`));
  assert.match(coordination, /id="order-coordination"/);
  assert.match(coordination, /v-if="hasIssues" id="order-issues"/);
  assert.match(chat, /id="order-chat"/);
  for (const page of [staff, customer]) {
    assert.match(page, /order(?:\.value)?\.issues\.length \? \[\{ hash: '#order-issues', label: 'Вопросы' \}\] : \[\]/);
    assert.match(page, /\{ hash: '#order-chat', label: 'Чат' \}/);
    assert.match(page, /:has-issues="order\.issues\.length > 0"/);
  }
  assert.match(payment, /id="order-payment"/);
  assert.match(sections, /position: sticky/);
  assert.match(sections, /min-height: var\(--touch-target\)/);
  assert.match(sections, /aria-current/);
  assert.match(sections, /@media \(min-width: 48rem\)[\s\S]*position: static/);
  assert.ok(staff.indexOf('<OrderSections') < staff.indexOf('id="order-data"'));
  assert.ok(staff.indexOf('<OrderExtras') > staff.indexOf('id="assembly"'));
  assert.ok(staff.indexOf('<OrderStaffPayment') > staff.indexOf('id="order-summary"'));
});

test('mobile assembly cards collapse details while desktop keeps actions visible', async () => {
  const [staff, progress, extras] = await Promise.all([
    source('pages/staff/orders/[id].vue'),
    source('components/order/Progress.vue'),
    source('components/order/Extras.vue'),
  ]);
  assert.match(staff, /:aria-expanded="openItemId === item\.id"/);
  assert.match(staff, /focusedAssemblyItem\(/);
  assert.match(staff, /\.item__details \{\s*display: none/);
  assert.match(staff, /@media \(min-width: 40rem\)[\s\S]*\.item__details \{ display: grid; \}/);
  for (const action of ['Собрано', 'Нет в наличии', 'Сбросить', 'Вернуть в сборку'])
    assert.ok(staff.includes(action));
  assert.match(staff, /item\.unit === 'GRAM' \? 'Фактический вес, г' : 'Фактическое количество'/);
  assert.ok(staff.indexOf('v-model.number="actual[item.id]"') < staff.indexOf('<OrderWeight'));
  assert.match(staff, /<OrderItemPrice/);
  assert.match(progress, /\.order-progress__steps \{\s*display: flex/);
  assert.match(progress, /@media \(min-width: 40rem\)[\s\S]*display: grid/);
  for (const action of ['Добавить услугу', 'Изменить', 'Отменить услугу', 'Сохранить'])
    assert.ok(extras.includes(action));
});

test('changed order item price is visible to customer before payment', async () => {
  const [staff, customer, price] = await Promise.all([
    source('pages/staff/orders/[id].vue'),
    source('pages/order/[id].vue'),
    source('components/order/ItemPrice.vue'),
  ]);
  assert.match(staff, /Цена изменена:/);
  assert.match(customer, /Цена изменена:/);
  assert.match(customer, /изменения цены войдут в итог после сборки/);
  assert.match(price, /Фактическая цена, ₽/);
  assert.match(price, /requestId: crypto\.randomUUID\(\)/);
  assert.match(price, /retry\.value \?\?/);
});
