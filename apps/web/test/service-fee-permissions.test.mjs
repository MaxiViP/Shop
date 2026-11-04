import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'vue/compiler-sfc';
import { compile, createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

async function page(file, permissions) {
  const source = await readFile(new URL('../app/pages/admin/' + file, import.meta.url), 'utf8');
  const template = parse(source).descriptor.template.content;
  const wrapper = { setup: (_props, { slots }) => () => h('div', [slots.header?.(), slots.default?.()]) };
  const components = Object.fromEntries([
    'UCard', 'UButton', 'UAlert', 'UFormField', 'UInput', 'USwitch', 'USelect',
    'UCheckbox', 'UBadge', 'NuxtLink', 'AdminCategories', 'AdminConfirm',
  ].map(name => [name, wrapper]));
  components.AdminServiceFeeSettings = { render: () => h('div', { 'data-fee-control': 'global' }) };
  components.AdminServiceFeeBulk = { render: () => h('div', { 'data-fee-control': 'bulk' }) };
  const noop = () => {};
  const item = { id: 1, name: 'Fixture', images: [], category: { name: 'Fixture' },
    price: 10000, priceQty: 1, unit: 'PIECE', serviceMarkupPercentOverride: 0,
    serviceMarkupPercent: 0, serviceMarkup: 0, customerPrice: 10000,
    serviceMarkupNeedsReview: false, basePrice: null, settlementMode: 'UNSET', active: true };
  const app = createSSRApp({
    components,
    render: compile(template),
    setup: () => ({
      feePermissions: permissions, section: 'products', pending: false, error: null,
      data: { globalServiceMarkupPercent: 10, items: [item], pages: 1, total: 1 },
      feeSelection: [], hitSelection: [], query: { page: 1 }, busy: false,
      search: '', category: 0, active: 'all', mode: 'all', status: 'all', pointId: 0,
      feeMode: 'all', categoryItems: [], modeOptions: [], statusOptions: [], pointOptions: [],
      feeOptions: [], feeFilter: {}, hitModes: [], bulkHitMode: 'AUTO',
      labels: { PIECE: 'unit' }, priceStatusLabels: {}, modeLabel: {},
      selected: undefined, confirm: false, money: String, asset: String,
      moneyFields: [], amounts: {}, deliveryEnabled: true, pickupEnabled: true,
      freeDeliveryEnabled: false, freeDeliveryRubles: '', percent: '', responseMinutes: 5,
      partner1Name: '', partner2Name: '', apply: noop, feeApplied: noop, assignHits: noop,
      selectHit: noop, selectFee: noop, hide: noop, remove: noop, save: noop, refresh: noop,
    }),
  });
  app.config.warnHandler = (message) => { throw new Error(message); };
  return renderToString(app);
}

for (const [label, permissions, allowed] of [
  ['primary', { primaryAdmin: true }, true],
  ['delegated', { primaryAdmin: false }, false],
  ['unavailable permissions', undefined, false],
]) {
  test(`${label}: real settings/products templates enforce primary-only fee controls`, async () => {
    const settings = await page('settings.vue', permissions);
    const products = await page('products/index.vue', permissions);
    assert.equal(settings.includes('data-fee-control="global"'), allowed);
    assert.equal(products.includes('data-fee-control="bulk"'), allowed);
    assert.equal(products.includes('Выбор процентов'), allowed);
    assert.equal(products.includes('Выбрать процент для Fixture'), allowed);
  });
}
