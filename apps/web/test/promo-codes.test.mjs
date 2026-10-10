import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPinia, setActivePinia } from 'pinia';
import * as vue from 'vue';
import { renderToString } from 'vue/server-renderer';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import ts from 'typescript';
import { useCartStore } from '../app/stores/cart.ts';
import { money } from '../app/utils/money.ts';
import { promoDescription, promoDate, promoStatusLabels } from '../app/utils/promo.ts';
const product = { id: 1, name: 'Яблоки', slug: 'apples', price: 11000, priceQty: 1, unit: 'PIECE', min: 1, step: 1, portionQty: 1,
  priceStatus: 'ESTIMATED', images: [], category: { name: 'Фрукты', slug: 'fruits' }, marketPoint: null, isSeasonal: false, isHit: false,
  seasonalStartsAt: null, seasonalEndsAt: null };
const promo = { id: 10, code: 'KM-01234567890123456789', title: 'Персональная скидка', type: 'FIXED', amount: 5000, percentBps: null,
  maxDiscount: null, minSubtotal: 22000, expiresAt: '2099-01-01T00:00:00.000Z', status: 'AVAILABLE', usedAt: null, usedOrder: null,
  eligible: true, reason: null, discount: 5000 };
const base = { revision: 'rev-1', valid: true, token: 'quote-1', error: null, subtotal: 22000, goodsTotal: 22000, promo: null,
  promoCodes: [promo, { ...promo, id: 11, minSubtotal: 33000, eligible: false, discount: 0, reason: 'Сумма товаров меньше минимальной' }],
  items: [{ productId: 1, qty: 2, product, status: 'AVAILABLE', lineTotal: 22000 }], products: [product],
  delivery: { enabled: true, threshold: 22000, remaining: 0, progress: 1, eligible: true, price: 0, total: 22000 } };
function setup(responses = []) {
  setActivePinia(createPinia());
  const cart = useCartStore(), calls = [], notifications = [];
  let snapshot = structuredClone(base);
  cart.beginServer(1); cart.applyServer(snapshot, 1);
  cart.bindServer({ get: async () => snapshot, change: async body => {
    calls.push(body); const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next) snapshot = next;
    return snapshot;
  } });
  return { cart, calls, notifications };
}
async function selectorScope(f) {
  const source = await readFile(new URL('../app/components/promo/Selector.vue', import.meta.url), 'utf8');
  let script = parse(source).descriptor.scriptSetup.content;
  const ast = ts.createSourceFile('Selector.ts', script, ts.ScriptTarget.Latest, true);
  for (const node of [...ast.statements].reverse()) if (ts.isImportDeclaration(node)) script = script.slice(0,node.getStart()) + script.slice(node.end);
  const code = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function('useCartStore','useToast','ref','computed', code + '\nreturn { cart, selected, available, open, show, choose };')(
    () => f.cart, () => ({ add: item => f.notifications.push(item) }), vue.ref, vue.computed);
}
function compiledTemplate(source, id) {
  const descriptor = parse(source).descriptor;
  const compiled = compileTemplate({ source: descriptor.template.content, filename: id + '.vue', id });
  assert.deepEqual(compiled.errors, []);
  const code = ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; new Function('require', 'exports', code)(() => vue, exports);
  return { render: exports.render, descriptor };
}
async function renderSelector(scope) {
  const cardSource = await readFile(new URL('../app/components/promo/Card.vue', import.meta.url), 'utf8');
  const selectorSource = await readFile(new URL('../app/components/promo/Selector.vue', import.meta.url), 'utf8');
  const Card = vue.defineComponent({ props: ['promo','reason'], render: compiledTemplate(cardSource, 'card').render,
    setup: props => ({ ...vue.toRefs(props), money, promoDescription, promoDate, promoStatusLabels }) });
  const Selector = vue.defineComponent({ render: compiledTemplate(selectorSource, 'selector').render, setup: () => ({ ...scope, money }) });
  const app = vue.createSSRApp(Selector);
  app.component('PromoCard', Card);
  app.component('UBadge', { setup: (_, { slots }) => () => vue.h('span', slots.default?.()) });
  app.component('UButton', { props: ['disabled'], setup: (props, { slots }) => () => vue.h('button', { disabled: props.disabled }, slots.default?.()) });
  app.component('UModal', { props: ['open'], setup: (props, { slots }) => () => props.open ? vue.h('section', { role: 'dialog' }, slots.body?.()) : null });
  return renderToString(app);
}
test('describes fixed and capped percentage discounts without deriving a payable amount on the client', () => {
  assert.match(promoDescription(promo), /5.*000|50/);
  assert.match(promoDescription({ ...promo, type: 'PERCENT', amount: null, percentBps: 1250, maxDiscount: 3000 }), /12,5%.*30/);
  assert.match(promoDate('2026-10-10T21:30:00.000Z'), /11.*2026.*00:30/);
});
test('applies one server-selected code and removes it without submitting money or changing the free-delivery base', async () => {
  const applied = { ...structuredClone(base), revision: 'rev-2', token: 'quote-2', promo, goodsTotal: 17000, delivery: { ...base.delivery, total: 17000 } };
  const f = setup([applied, { ...structuredClone(base), revision: 'rev-3', token: 'quote-3' }]);
  const scope = await selectorScope(f); scope.open.value = true; await scope.choose(10);
  assert.deepEqual(f.calls[0], { kind: 'promo', promoCodeId: 10, revision: 'rev-1' });
  assert.equal(f.cart.total, 22000); assert.equal(f.cart.quote.goodsTotal, 17000);
  assert.equal(f.cart.quote.delivery.eligible, true); assert.equal(scope.selected.value.id, 10); assert.equal(scope.open.value, false);
  await scope.choose(null); assert.equal(scope.selected.value, null); assert.equal(f.cart.quote.goodsTotal, 22000);
});
test('a cart quantity change replaces the quote and makes the selected compensation visibly unavailable', async () => {
  const applied = { ...structuredClone(base), promo, goodsTotal: 17000 };
  const changed = { ...applied, revision: 'rev-2', token: 'quote-2', subtotal: 11000, goodsTotal: 11000,
    promo: { ...promo, eligible: false, discount: 0, reason: 'Сумма товаров меньше минимальной' },
    items: [{ ...base.items[0], qty: 1, lineTotal: 11000 }] };
  const f = setup([changed]); f.cart.applyServer(applied, 1);
  const scope = await selectorScope(f);
  await f.cart.changeServer({ kind: 'set', productId: 1, qty: 1 });
  assert.equal(f.cart.quoteReady, true); assert.equal(scope.selected.value.eligible, false);
  const html = await renderSelector(scope); assert.match(html, /Сумма товаров меньше минимальной/); assert.match(html, /Убрать скидку/);
});
test('failed or concurrent application leaves the modal open and reports the failure', async () => {
  const f = setup([Object.assign(new Error('changed'), { statusCode: 409 })]), scope = await selectorScope(f);
  scope.open.value = true; await scope.choose(10);
  assert.equal(scope.open.value, true); assert.equal(scope.selected.value, null); assert.equal(f.notifications.length, 1);
});
test('switching accounts removes coupon data and rejects a stale cart response', async () => {
  const f = setup(); f.cart.applyServer({ ...base, promo }, 1);
  f.cart.beginServer(2); assert.equal(f.cart.quote, null);
  assert.equal(f.cart.applyServer({ ...base, promo }, 1), false);
  f.cart.beginGuest(); assert.equal(f.cart.quote, null); assert.equal(f.cart.serverOwner, null);
});
test('the rendered list explains eligibility and renders unavailable buttons disabled, without admin comments', async () => {
  const f = setup(), scope = await selectorScope(f);
  f.cart.quote.promoCodes[0].reasonPrivate = 'internal-only-compensation-note';
  await scope.show();
  const html = await renderSelector(scope);
  assert.match(html, /Ваши промокоды|role="dialog"/); assert.match(html, /KM-01234567890123456789/);
  assert.match(html, /Сумма товаров меньше минимальной/); assert.match(html, /disabled/);
  assert.doesNotMatch(html, /internal-only-compensation-note/);
});
test('mobile promo lists keep a bounded scroll region, wrap long codes and validate every SFC section order', async () => {
  for (const path of ['promo/Card.vue','promo/Selector.vue','promo/Wallet.vue','order/Costs.vue','order/PromoDiscount.vue']) {
    const source = await readFile(new URL('../app/components/' + path, import.meta.url), 'utf8');
    const { descriptor, errors } = parse(source); assert.deepEqual(errors, []);
    assert.ok(source.indexOf('<template>') < source.indexOf('<script setup lang="ts">'));
    assert.ok(source.indexOf('<script setup lang="ts">') < source.indexOf('<style scoped>'));
    assert.match(descriptor.styles[0].content, /min-width:\s*0|overflow-wrap:\s*anywhere/);
  }
  const selector = await readFile(new URL('../app/components/promo/Selector.vue', import.meta.url), 'utf8');
  assert.match(selector, /w-\[calc\(100%-2rem\)\]/); assert.match(selector, /max-height:\s*65dvh/); assert.match(selector, /overflow-y:\s*auto/);
  const card = await readFile(new URL('../app/components/promo/Card.vue', import.meta.url), 'utf8');
  assert.match(card, /word-break:\s*break-all/);
});
