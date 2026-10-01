import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const read = file => readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
const routes = ['pages/admin/index.vue', 'pages/admin/orders/index.vue',
  'pages/admin/orders/[id].vue', 'pages/admin/finance.vue',
  'pages/admin/payouts.vue', 'pages/admin/schedule.vue'];
test('all operations pages require ADMIN middleware and layout', async () => {
  for (const route of routes) {
    const source = await read(route);
    assert.match(source, /definePageMeta\(\{ middleware: 'admin', layout: 'admin' \}\)/);
    assert.ok(source.indexOf('<template>') < source.indexOf('<script setup lang="ts">'));
  }
});
test('product settlement editor previews split and omits base for excluded products', async () => {
  const form = await read('components/admin/ProductForm.vue');
  assert.match(form, /Внутренний расчёт/);
  assert.match(form, /settlementMode === 'SHARED_MARKUP'/);
  assert.match(form, /settlementMode: settlementMode.value/);
  assert.match(form, /const basePrice = settlementMode.value === "SHARED_MARKUP" \? rublesToKopecks\(baseRubles.value\) : null/);
  assert.match(form, /const partner1 = Math.trunc\(markup \/ 2\)/);
  assert.match(form, /partner2: markup - partner1/);
});
test('orders use server filters, URL query persistence, pagination and mobile cards', async () => {
  const page = await read('pages/admin/orders/index.vue');
  assert.match(page, /useApi<AdminPage<AdminOrderRow>>\('\/admin\/orders', \{ query \}\)/);
  assert.match(page, /Object.entries\(route.query\)/);
  assert.match(page, /md:hidden/);
  assert.match(page, /page: String\(page.value \+ delta\)/);
});
test('finance drills to day and server CSV; schedule and checkout share the public status', async () => {
  const finance = await read('pages/admin/finance.vue');
  const schedule = await read('pages/admin/schedule.vue');
  const status = await read('components/app/ShopStatus.vue');
  const checkout = await read('pages/cart.vue');
  assert.match(finance, /\/admin\/finance\/days\/\$\{day\}/);
  assert.match(finance, /\/admin\/finance\/export\.csv/);
  assert.match(schedule, /\/admin\/schedule\/weekly\/\$\{row.weekday\}/);
  assert.match(schedule, /\/admin\/schedule\/exceptions/);
  assert.match(status, /useApi<ShopStatus>\('\/shop\/status'\)/);
  assert.match(checkout, /<AppShopStatus/);
});
