import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, ref } from "vue";

const source = await readFile(new URL("../app/components/cart/Items.vue", import.meta.url), "utf8");
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile("Items.ts", script, ts.ScriptTarget.Latest, true);
let executable = script;
for (const statement of [...parsed.statements].reverse())
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture() {
  const product = { id: 1, name: "Apple", slug: "apple" };
  const cart = { items: [{ product, qty: 2 }], quoteReady: true };
  const props = { disabled: false };
  const scheduled = new Map();
  const watchers = [];
  const emitted = [];
  const notices = [];
  let nextId = 0;
  let removes = 0;
  let unmount;
  const context = {
    defineProps: () => props,
    defineEmits: () => (...values) => emitted.push(values),
    useCartStore: () => cart,
    useCartActions: () => ({
      remove: async id => {
        removes++;
        cart.items = cart.items.filter(item => item.product.id !== id);
        return true;
      },
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
  const setup = new Function(...Object.keys(context),
    executable + "\nreturn { toggleRemoval, countdowns, timers };");
  const result = setup(...Object.values(context));
  function tick() {
    const [id, timer] = scheduled.entries().next().value;
    scheduled.delete(id);
    timer.callback();
    return timer.delay;
  }
  return { ...result, props, cart, watchers, emitted, notices, tick,
    unmount: () => unmount(),
    get removes() { return removes; },
    get scheduled() { return scheduled.size; } };
}

test("remove shows three-second countdown, second click cancels, then removes once", async () => {
  const f = fixture();
  f.toggleRemoval(1);
  assert.equal(f.countdowns.value[1], 3);
  f.toggleRemoval(1);
  assert.equal(f.countdowns.value[1], undefined);
  assert.equal(f.scheduled, 0);
  assert.equal(f.removes, 0);
  f.toggleRemoval(1);
  assert.deepEqual([f.tick(), f.tick(), f.tick(), f.tick()], [1000, 1000, 1000, 250]);
  await Promise.resolve();
  assert.equal(f.removes, 1);
  assert.deepEqual(f.cart.items, []);
  assert.deepEqual(f.emitted[0][0], "removed");
  assert.equal(f.countdowns.value[1], undefined);
});

test("disabled, disappearing item and unmount each cancel a pending timer", () => {
  for (const cleanup of ["disabled", "disappear", "unmount"]) {
    const f = fixture();
    f.toggleRemoval(1);
    assert.equal(f.scheduled, 1);
    if (cleanup === "disabled") {
      f.props.disabled = true;
      f.watchers[0].callback(true);
    } else if (cleanup === "disappear") {
      f.cart.items = [];
      f.watchers[1].callback([]);
    } else {
      f.unmount();
    }
    assert.equal(f.scheduled, 0);
    assert.equal(f.countdowns.value[1], undefined);
    assert.equal(f.removes, 0);
  }
});

test("remove styling is scoped to cart item and keeps the touch target", () => {
  assert.match(source, /\.item__remove \{[^}]*color: red;[^}]*border: 1px solid;/);
  assert.match(source, /\.item__qty :deep\(button\),\s*\.item__remove \{[^}]*width: var\(--touch-target\);/);
});
