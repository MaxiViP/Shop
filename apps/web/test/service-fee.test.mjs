import assert from 'node:assert/strict';
import test from 'node:test';
import { ref, reactive, computed, watch, nextTick } from 'vue';
import { serviceHelpers, serviceComponent } from './fixtures/service-fee.mjs';
import * as money from '../app/utils/money.ts';
import * as quantity from '../app/utils/assembly.ts';
import * as sale from '../app/utils/sale.ts';
import { nextCartQty } from '../app/utils/cart.ts';
import { qtyText } from '../app/utils/qty.ts';
import { priceStatusItems } from '../app/utils/price-status.ts';
import { hitModes, seasonGroupLabel } from '../app/utils/badges.ts';
const helpers = await serviceHelpers();
const { servicePercent, serviceFeeError } = helpers;

const base = { id: 1, name: 'Товар', slug: 'product', price: 10000, sellerPrice: 10000,
  serviceMarkupPercent: 10, serviceMarkupPercentOverride: 10, serviceMarkupNeedsReview: true,
  serviceMarkup: 1000, customerPrice: 11000, categoryId: 1, marketPointId: 10,
  priceQty: 1, min: 1, step: 1, portionQty: 1, unit: 'PIECE', active: true, sort: 0,
  settlementMode: 'UNSET', seasonalMode: 'OFF', priceStatus: 'ESTIMATED' };

async function productForm(t, { product = base, owner = false, global = 10 } = {}) {
  const requests = [], reads = [], stops = [];
  const remoteGlobal = ref(null);
  const stored = { ...product }, settings = ref({ globalServiceMarkupPercent: global });
  t.after(() => stops.forEach(stop => stop()));
  const context = { ...money, ...quantity, ...sale, ...helpers, ref, reactive, computed, qtyText, nextCartQty, priceStatusItems, hitModes, seasonGroupLabel,
    defineProps: () => ({ product: product ? stored : undefined, owner, categories: [{ id: 1, name: 'Категория', active: true }] }),
    defineEmits: () => () => {}, onMounted() {}, onBeforeUnmount() {},
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    useApi: async path => { reads.push(path); return { data: path === '/admin/settings' ? settings : ref([]), error: ref(null), pending: ref(false), refresh: async () => {} }; },
    useApiClient: () => async (path, options) => {
      requests.push({ path, ...options });
      const body = options.body;
      assert.ok(!Object.hasOwn(body, 'serviceMarkupPercent'));
      assert.ok(!Object.hasOwn(body, 'serviceMarkupNeedsReview'));
      if (path.endsWith('/pricing')) {
        const override = owner ? stored.serviceMarkupPercentOverride : body.serviceMarkupPercentOverride;
        const percent = override ?? remoteGlobal.value ?? settings.value.globalServiceMarkupPercent;
        // Fixed backend fixtures, never a client monetary calculation.
        return { sellerPrice: 10000, serviceMarkupPercent: percent, serviceMarkupPercentOverride: override,
          customerPrice: new Map([[0,10000],[10,11000],[15,11500],[20,12000],[100,20000]]).get(percent), serviceMarkup: 0 };
      }
      const explicit = Object.hasOwn(body, 'serviceMarkupPercentOverride');
      Object.assign(stored, body, { serviceMarkupNeedsReview: explicit ? false : stored.serviceMarkupNeedsReview });
      return { ...stored, serviceMarkupPercent: stored.serviceMarkupPercentOverride ?? settings.value.globalServiceMarkupPercent };
    },
    useToast: () => ({ add() {} }), navigateTo: async () => {}, apiError: cause => String(cause),
  };
  const form = await serviceComponent('ProductForm.vue', context,
    'form, feeMode, feeOverride, feeNeedsReview, individualPercent, selectFeeMode, useGlobalFee, confirmGlobal, reviewConfirmed, save, rubles, pricing, error, refreshServiceFee');
  return { ...form, requests, reads, settings, remoteGlobal };
}
const settle = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 240)); };

test('service percent validation preserves zero and rejects fractional/out-of-range values', () => {
  for (const value of ['0', 0, '10', '15', '100', 100]) assert.equal(servicePercent(value), Number(value));
  for (const value of ['', '-1', '101', '10.5', '1e2', 'abc']) assert.equal(servicePercent(value), null);
  for (const cause of [{ status: 409 }, { statusCode: 409 }, { response: { status: 409 } }])
    assert.equal(serviceFeeError(cause), 'Настройки сейчас обновляются или используются при оформлении заказа. Повторите попытку');
  assert.equal(serviceFeeError({ data: { message: 'Нет доступа' } }), 'Нет доступа');
});

for (const percent of [10,15,0,100]) test(`global settings confirmation saves only ${percent}%`, async () => {
  const props = reactive({ percent: percent === 10 ? 15 : 10 }), requests = [], events = [];
  const panel = await serviceComponent('ServiceFeeSettings.vue', {
    ref, computed, watch, ...helpers, defineProps: () => props, defineEmits: () => event => events.push(event),
    useToast: () => ({ add() {} }), useApiClient: () => async (path, options) => { requests.push({ path, ...options }); props.percent = options.body.globalServiceMarkupPercent; },
  }, 'draft, requestSave, save, confirm, error, busy');
  panel.draft.value = String(percent); panel.requestSave();
  assert.equal(panel.confirm.value, true); assert.equal(requests.length, 0);
  await panel.save();
  assert.deepEqual(requests, [{ path: '/admin/settings', method: 'PATCH', body: { globalServiceMarkupPercent: percent } }]);
  assert.deepEqual(events, ['saved']); assert.equal(panel.error.value, ''); assert.equal(panel.busy.value, false);
});

test('global settings validates and reports 409 without retrying', async () => {
  let count = 0;
  const panel = await serviceComponent('ServiceFeeSettings.vue', {
    ref, computed, watch, ...helpers, defineProps: () => ({ percent: 10 }), defineEmits: () => () => {},
    useToast: () => ({ add() {} }), useApiClient: () => async () => { count++; throw { statusCode: 409 }; },
  }, 'draft, requestSave, save, confirm, error, target');
  panel.draft.value = '101'; panel.requestSave(); assert.equal(panel.confirm.value, false);
  panel.draft.value = '15'; panel.requestSave(); await panel.save();
  assert.equal(count, 1); assert.equal(panel.confirm.value, false); assert.equal(panel.target.value, 15);
  assert.match(panel.error.value, /Настройки сейчас обновляются/);
});

for (const percent of [0,10,20]) test(`individual ${percent}% persists and preview uses the server`, async t => {
  const f = await productForm(t, { product: { ...base, serviceMarkupPercentOverride: percent, serviceMarkupPercent: percent, serviceMarkupNeedsReview: false } });
  assert.equal(f.feeMode.value, 'individual'); assert.equal(f.feeOverride.value, percent);
  f.individualPercent.value = percent === 20 ? '10' : '20'; await nextTick();
  f.individualPercent.value = String(percent); await settle();
  assert.equal(f.pricing.value.serviceMarkupPercent, percent);
  assert.equal(f.requests.at(-1).body.serviceMarkupPercentOverride, percent);
  f.settings.value.globalServiceMarkupPercent = 100; await settle();
  assert.equal(f.pricing.value.serviceMarkupPercent, percent);
  await f.save(); assert.ok(!Object.hasOwn(f.requests.at(-1).body, 'serviceMarkupPercentOverride'), 'An unchanged exception stays untouched');
});

test('legacy review survives ordinary saves; explicit review clears it once', async t => {
  const f = await productForm(t);
  assert.equal(f.feeMode.value, 'individual'); assert.equal(f.feeNeedsReview.value, true);
  await f.save(); assert.ok(!Object.hasOwn(f.requests.at(-1).body, 'serviceMarkupPercentOverride'));
  assert.equal(f.feeNeedsReview.value, true);
  f.reviewConfirmed.value = true; await f.save();
  assert.equal(f.requests.at(-1).body.serviceMarkupPercentOverride, 10);
  assert.equal(f.feeNeedsReview.value, false);
  await f.save(); assert.ok(!Object.hasOwn(f.requests.at(-1).body, 'serviceMarkupPercentOverride'));
});

test('switching to global requires confirmation, clears override and refreshes preview', async t => {
  const f = await productForm(t);
  f.selectFeeMode('global'); assert.equal(f.confirmGlobal.value, true); assert.equal(f.feeOverride.value, 10);
  f.confirmGlobal.value = false; assert.equal(f.feeMode.value, 'individual');
  f.selectFeeMode('global'); f.useGlobalFee();
  assert.equal(f.individualPercent.value, ''); assert.equal(f.feeOverride.value, null);
  f.settings.value.globalServiceMarkupPercent = 15; await settle();
  assert.equal(f.pricing.value.customerPrice, 11500);
  assert.deepEqual(f.requests.at(-1).body, { price: 10000, serviceMarkupPercentOverride: null });
  await f.save(); assert.equal(f.requests.at(-1).body.serviceMarkupPercentOverride, null);
  assert.equal(f.feeNeedsReview.value, false);
  f.selectFeeMode('individual'); f.individualPercent.value = '0'; await f.save();
  assert.equal(f.requests.at(-1).body.serviceMarkupPercentOverride, 0);
});

test('new products default to global and validation stops invalid overrides', async t => {
  const f = await productForm(t, { product: null, global: 15 });
  assert.equal(f.feeMode.value, 'global');
  Object.assign(f.form, { name: 'Товар', slug: 'new-product', categoryId: 1 }); f.rubles.value = '100';
  await f.save(); assert.equal(f.requests.at(-1).method, 'POST'); assert.equal(f.requests.at(-1).body.serviceMarkupPercentOverride, null);
  f.selectFeeMode('individual'); f.individualPercent.value = '101';
  const before = f.requests.length; await f.save(); assert.equal(f.requests.length, before); assert.match(f.error.value, /от 0 до 100/);
});

test('owner does not read admin settings and cannot send either percentage field', async t => {
  const f = await productForm(t, { owner: true });
  assert.ok(!f.reads.includes('/admin/settings'));
  f.individualPercent.value = '100'; await settle(); await f.save();
  const update = f.requests.at(-1);
  assert.equal(update.path, '/owner/products/1');
  assert.ok(!Object.hasOwn(update.body, 'serviceMarkupPercentOverride'));
  assert.ok(!Object.hasOwn(update.body, 'serviceMarkupPercent'));
});


test('a newer global server preview updates the displayed global setting too', async t => {
  const f = await productForm(t, { product: { ...base, serviceMarkupPercentOverride: null, serviceMarkupNeedsReview: false } });
  f.remoteGlobal.value = 15;
  await f.refreshServiceFee(); await settle(); await settle();
  assert.equal(f.settings.value.globalServiceMarkupPercent, 15);
  assert.equal(f.pricing.value.serviceMarkupPercent, 15);
  assert.equal(f.pricing.value.customerPrice, 11500);
});
