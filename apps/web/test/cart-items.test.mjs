import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, ref } from "vue";
import { previousCartQty, validCartQty } from '../app/utils/cart.ts';
import { manualQuantity } from '../app/utils/assembly.ts';
import { qtyText } from '../app/utils/qty.ts';

async function executable(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile('component.ts', script, ts.ScriptTarget.Latest, true);
  let code = script;
  for (const statement of [...parsed.statements].reverse())
    if (ts.isImportDeclaration(statement))
      code = code.slice(0, statement.getStart()) + code.slice(statement.end);
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const itemsCode = await executable('../app/components/cart/Items.vue');
const clearCode = await executable('../app/components/cart/Clear.vue');
const qtyCode = await executable('../app/components/product/Qty.vue');

function fixture(clear = false) {
  const product = { id: 1, name: 'Apple', slug: 'apple' };
  const cart = { items: [{ product, qty: 2, quantityUnit: 'PIECE', weightMinGrams: 100 }], quoteReady: true, count: 1, serverBusy: false };
  const props = { disabled: false };
  const scheduled = new Map(), watchers = [], emitted = [], notices = [], updates = [];
  let nextId = 0, removes = 0, clears = 0, unmount, success = true;
  const context = {
    defineProps: () => props,
    defineEmits: () => (...values) => emitted.push(values),
    useCartStore: () => cart,
    useCartActions: () => ({
      remove: async id => {
        removes++;
        if (success) cart.items = cart.items.filter(item => item.product.id !== id);
        return success;
      },
      setQty: async (id, qty) => { updates.push([id, qty]); return success; },
      clear: async () => { clears++; if (success) { cart.items = []; cart.count = 0; } return success; },
    }),
    useAsset: () => value => value,
    useHeaderNotice: () => ({ show: value => notices.push(value) }),
    computed, ref,
    watch: (source, callback) => watchers.push({ source, callback }),
    onBeforeUnmount: callback => { unmount = callback; },
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => scheduled.delete(id),
  };
  const setup = new Function(...Object.keys(context), (clear ? clearCode : itemsCode) +
    (clear ? '\nreturn { toggleRemoval, countdown };' : '\nreturn { setQty };'));
  const result = setup(...Object.values(context));
  function tick() {
    const [id, timer] = scheduled.entries().next().value;
    scheduled.delete(id);
    timer.callback();
    return timer.delay;
  }
  return { ...result, props, cart, watchers, emitted, notices, updates, tick,
    fail: () => { success = false; }, unmount: () => unmount(),
    get removes() { return removes; }, get clears() { return clears; },
    get scheduled() { return scheduled.size; } };
}

test('clear countdown can be cancelled and clears once only after expiry', async () => {
  const f = fixture(true);
  f.toggleRemoval();
  assert.equal(f.countdown.value, 3);
  assert.equal(f.clears, 0);
  f.toggleRemoval();
  assert.equal(f.countdown.value, null);
  assert.equal(f.scheduled, 0);
  f.toggleRemoval();
  assert.deepEqual([f.tick(), f.tick(), f.tick(), f.tick()], [1000, 1000, 1000, 250]);
  await Promise.resolve();
  assert.equal(f.clears, 1);
  assert.deepEqual(f.cart.items, []);
  assert.deepEqual(f.emitted, [['cleared']]);
  assert.equal(f.countdown.value, null);
});

test('checkout lock, emptied cart and unmount cancel pending clear', () => {
  for (const cleanup of ['disabled', 'empty', 'unmount']) {
    const f = fixture(true);
    f.toggleRemoval();
    if (cleanup === 'disabled') {
      f.props.disabled = true;
      f.watchers[0].callback(true);
    } else if (cleanup === 'empty') {
      f.cart.count = 0;
      f.watchers[1].callback(0);
    } else f.unmount();
    assert.equal(f.scheduled, 0);
    assert.equal(f.countdown.value, null);
    assert.equal(f.clears, 0);
  }
});

test('failed clear preserves basket and emits no success', async () => {
  const f = fixture(true);
  f.fail(); f.toggleRemoval();
  for (let i = 0; i < 4; i++) f.tick();
  await Promise.resolve();
  assert.equal(f.cart.items.length, 1);
  assert.deepEqual(f.emitted, []);
  assert.deepEqual(f.notices, []);
});

test('zero delegates removal to the page with the full draft; positive quantity updates', async () => {
  const f = fixture();
  const original = { ...f.cart.items[0] };
  await f.setQty(1, 3);
  assert.deepEqual(f.updates, [[1, 3]]);
  await f.setQty(1, 0);
  assert.equal(f.removes, 0);
  assert.deepEqual(f.emitted, [['remove', original]]);
});

test('locked mutations are ignored and a failed update does not claim success', async () => {
  const f = fixture();
  f.props.disabled = true;
  await f.setQty(1, 0);
  assert.equal(f.removes, 0);
  f.props.disabled = false;
  f.cart.serverBusy = true;
  await f.setQty(1, 0);
  assert.equal(f.removes, 0);
  f.cart.serverBusy = false;
  f.fail();
  await f.setQty(1, 3);
  assert.equal(f.cart.items.length, 1);
  assert.deepEqual(f.emitted, []);
});

function counter(product, qty, props = {}) {
  const value = ref(qty);
  const context = { defineProps: () => ({ product, ...props }), defineModel: () => value,
    computed, previousCartQty, validCartQty, manualQuantity, qtyText };
  return new Function(...Object.keys(context), qtyCode + '\nreturn { dec, inc, decreased, label, value };')(...Object.values(context));
}
test('cart minus reaches zero for pieces, grams and whole specimens; other quantity inputs retain minimum', () => {
  for (const product of [
    { unit: 'PIECE', min: 1, step: 1, portionQty: 1 },
    { unit: 'GRAM', min: 500, step: 100, portionQty: 500 },
    { unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_BY_WEIGHT', min: 1, step: 1, portionQty: 1 },
  ]) {
    const cart = counter(product, product.min + product.step, { removable: true });
    assert.equal(cart.decreased.value, product.min);
    cart.dec();
    assert.equal(cart.decreased.value, 0);
    cart.dec();
    assert.equal(cart.value.value, 0);
    const detail = counter(product, product.min);
    assert.equal(detail.decreased.value, product.min);
  }
  assert.equal(counter({ unit: 'GRAM', min: 500, step: 100, portionQty: 500 }, 450, { removable: true }).decreased.value, 0);
});

test('unavailable or changed-sale items can be removed with minus without a positive quantity mutation', () => {
  const product = { unit: 'PIECE', min: 1, step: 1, portionQty: 1 };
  const qty = counter(product, 8, { removable: true, removeOnly: true });
  qty.inc();
  assert.equal(qty.value.value, 8);
  qty.dec();
  assert.equal(qty.value.value, 0);
});
