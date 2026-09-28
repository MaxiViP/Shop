import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, nextTick, ref, watch } from "vue";
import { createPinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import { decodeCart, previewTotal, validCartQty } from "../app/utils/cart.ts";

const product = {
  id: 1, name: "Apples", slug: "apples", price: 350000, priceQty: 1000,
  unit: "GRAM", min: 500, step: 100, portionQty: 500, images: [],
  category: { name: "Fruit", slug: "fruit" }, description: null,
};
const savedProduct = { ...product, id: 2, name: "Pears", slug: "pears" };
const pageSource = await readFile(new URL("../app/pages/product/[slug].vue", import.meta.url), "utf8");
const pluginSource = await readFile(new URL("../app/plugins/cart.client.ts", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function withoutImports(source) {
  const parsed = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  let result = source;
  for (const statement of [...parsed.statements].reverse()) {
    if (ts.isImportDeclaration(statement))
      result = result.slice(0, statement.getStart()) + result.slice(statement.end);
  }
  return ts.transpileModule(result, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

function restoration(cart, initial) {
  let saved = initial;
  const hooks = new Map();
  const reads = [];
  const storage = {
    getItem(key) { reads.push(key); return saved; },
    setItem(key, value) { assert.equal(key, "cart"); saved = value; },
    removeItem(key) { assert.equal(key, "cart"); saved = null; },
  };
  const browserWindow = { addEventListener() {}, location: { pathname: "/product/apples" } };
  const document = { addEventListener() {}, visibilityState: "visible" };
  const executable = withoutImports(pluginSource).replace("export default", "return");
  const install = new Function(
    "defineNuxtPlugin", "useCartStore", "useAuthStore", "useApiClient",
    "decodeCart", "localStorage", "watch", "window", "document", executable,
  )(
    setup => setup, () => cart, () => ({ user: null }),
    () => async () => { throw new Error("Guest cart must not request server cart"); },
    decodeCart, storage, watch, browserWindow, document,
  );
  install({ hooks: { hook: (name, callback) => hooks.set(name, callback) } });
  assert.deepEqual([...hooks.keys()], ["page:finish"]);
  return { finish: hooks.get("page:finish"), reads, get saved() { return saved; } };
}

async function detail(t, cart) {
  const stops = [];
  t.after(() => stops.forEach(stop => stop()));
  const script = pageSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const executable = withoutImports(script);
  const notices = [];
  const context = {
    useRoute: () => ({ params: { slug: product.slug } }),
    useCartStore: () => cart,
    useCartActions: () => ({ put: async (p, qty) => cart.put(p, qty) }),
    useHeaderNotice: () => ({ show: notice => notices.push(notice) }),
    useApi: async path => {
      assert.equal(path, "/products/apples");
      return { data: ref(product), error: ref(null) };
    },
    ref, computed,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    previewTotal, validCartQty,
    usePageSeo() {}, useJsonLd() {},
  };
  const setup = new AsyncFunction(...Object.keys(context), executable + "\nreturn { add, qty, total, cartQty };");
  const state = await setup(...Object.values(context));
  assert.match(pageSource, /:disabled="!cart\.restored \|\| cart\.serverBusy \|\| total === null" @click="add"/);
  return { ...state, notices };
}

test("fresh product route waits for restore, then click adds immediately and persists the saved cart", async t => {
  const cart = useCartStore(createPinia());
  const initial = JSON.stringify({ version: 1, items: [{ product: savedProduct, qty: 500 }] });
  const storage = restoration(cart, initial);
  const page = await detail(t, cart);
  assert.equal(cart.restored, false);
  assert.equal(page.total.value, 175000);
  await page.add();
  assert.equal(cart.count, 0);
  assert.equal(storage.saved, initial);

  storage.finish();
  assert.equal(cart.restored, true);
  assert.equal(storage.reads.length, 1);
  assert.equal(cart.qty(savedProduct.id), 500);
  await page.add();
  assert.equal(cart.count, 2);
  assert.equal(cart.qty(product.id), 500);
  assert.equal(page.cartQty.value, 500);
  assert.equal(cart.key, "[[2,500],[1,500]]");
  assert.equal(cart.quoteReady, false);
  await nextTick();
  assert.deepEqual(JSON.parse(storage.saved).items.map(item => item.product.id), [2, 1]);
  assert.equal(page.notices.at(-1).target, "cart");
});

test("product detail sets the desired quantity on one existing cart row", async t => {
  const cart = useCartStore(createPinia());
  const storage = restoration(cart, JSON.stringify({ version: 1, items: [{ product, qty: 500 }] }));
  storage.finish();
  const page = await detail(t, cart);
  assert.equal(page.qty.value, 500);
  page.qty.value = 800;
  assert.equal(page.total.value, 280000);
  await page.add();
  assert.equal(cart.count, 1);
  assert.equal(cart.qty(product.id), 800);
  assert.equal(cart.key, "[[1,800]]");
  await nextTick();
  assert.equal(JSON.parse(storage.saved).items[0].qty, 800);
});


test("late page finish cannot replace an already restored product edit", async () => {
  const cart = useCartStore(createPinia());
  const storage = restoration(cart, JSON.stringify({ version: 1, items: [{ product: savedProduct, qty: 500 }] }));
  cart.restore([{ product, qty: 500 }]);
  assert.equal(cart.put(product, 800), true);
  const editedKey = cart.key;
  storage.finish();
  assert.equal(storage.reads.length, 0);
  assert.equal(cart.key, editedKey);
  assert.equal(cart.count, 1);
  assert.equal(cart.qty(product.id), 800);
});
