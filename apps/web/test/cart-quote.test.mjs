import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, defineComponent, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import { useCartQuote } from "../app/composables/useCartQuote.ts";

// A Vue host made of plain objects: no DOM, browser, HTTP, or production API.
const renderer = createRenderer({
  createElement: () => ({ children: [] }),
  createText: text => ({ text }),
  createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; parent.children.push(node); },
  remove(node) { node.parent.children = node.parent.children.filter(child => child !== node); },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; },
  parentNode: node => node.parent,
  nextSibling: () => null,
  patchProp() {},
});
const product = { id: 1, name: "Fixture", slug: "fixture", unit: "GRAM",
  price: 10000, priceQty: 1000, min: 500, step: 100, portionQty: 500,
  images: [], category: { name: "Fruit", slug: "fruit" } };
const response = (qty, subtotal) => ({
  valid: true, token: String(subtotal), error: null, subtotal,
  items: [{ productId: 1, product, qty, lineTotal: subtotal, status: "AVAILABLE" }],
});

test("layout and page share quotes, retries and cancellation across cart edits and page unmount", async () => {
  const previousApi = globalThis.useApiClient;
  const requests = [];
  globalThis.useApiClient = () => (url, options) => new Promise((resolve, reject) => {
    assert.equal(url, "/orders/quote");
    requests.push({ ...options, resolve, reject });
  });
  let owner;
  let page;
  const visible = ref(true);
  const Child = defineComponent({
    setup() { page = useCartQuote(); return () => h("div"); },
  });
  const Root = defineComponent({
    setup() { owner = useCartQuote(); return () => visible.value ? h(Child) : h("div"); },
  });
  const pinia = createPinia();
  const cart = useCartStore(pinia);
  const app = renderer.createApp(Root);
  app.use(pinia);
  let unmounted = false;
  try {
    app.mount({ children: [] });
    assert.equal(owner, page);
    assert.equal(requests.length, 0); // Unknown SSR/storage state cannot fetch.
    cart.restore([{ product, qty: 500 }]);
    await nextTick();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, { items: [{ productId: 1, qty: 500 }] });
    cart.add(product);
    await nextTick();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve(response(1000, 90000));
    await nextTick();
    requests[0].resolve(response(500, 1)); // A slow response cannot replace the latest quote.
    await nextTick();
    assert.equal(cart.total, 90000);
    assert.equal(owner.ready.value, true);
    visible.value = false;
    await nextTick();
    cart.subtract(product);
    await nextTick();
    assert.equal(requests.length, 3); // Header/card still get quotes without the cart page.
    assert.equal(cart.total, null);
    requests[2].reject(new Error("Offline"));
    await nextTick();
    assert.equal(cart.count, 1);
    assert.equal(owner.ready.value, false);
    assert.ok(owner.error.value);
    const retry = owner.refresh();
    requests[3].resolve(response(500, 45000));
    assert.equal(await retry, true);
    assert.equal(cart.total, 45000);
    assert.equal(owner.error.value, "");
    cart.add(product);
    await nextTick();
    cart.clear();
    await nextTick();
    assert.equal(requests[4].signal.aborted, true);
    assert.equal(owner.pending.value, false);
    requests[4].resolve(response(1000, 90000));
    await nextTick();
    assert.equal(cart.count, 0);
    assert.equal(cart.total, null);
    cart.add(product);
    await nextTick();
    app.unmount();
    unmounted = true;
    assert.equal(requests[5].signal.aborted, true);
    requests[5].resolve(response(500, 45000));
    await nextTick();
    assert.equal(cart.total, null);
  } finally {
    if (!unmounted) app.unmount();
    if (previousApi === undefined) delete globalThis.useApiClient;
    else globalThis.useApiClient = previousApi;
  }
});

test("500 -> 1000 -> 1500 has one lifecycle per key change with many injected consumers", async () => {
  const previousApi = globalThis.useApiClient;
  const requests = [];
  globalThis.useApiClient = () => (url, options) => new Promise(resolve => {
    requests.push({ url, ...options, resolve });
  });
  const consumers = [];
  let owner;
  const Child = defineComponent({
    setup() { consumers.push(useCartQuote()); return () => h("div"); },
  });
  const Root = defineComponent({
    setup() { owner = useCartQuote(); return () => h("div", Array.from({ length: 12 }, () => h(Child))); },
  });
  const pinia = createPinia();
  const cart = useCartStore(pinia);
  const app = renderer.createApp(Root);
  app.use(pinia);
  try {
    cart.restore([{ product, qty: 500 }]);
    app.mount({ children: [] });
    assert.equal(consumers.length, 12);
    assert.ok(consumers.every(state => state === owner));
    assert.equal(requests.length, 1);
    requests[0].resolve(response(500, 125000));
    await nextTick();
    cart.put({ ...product, price: 777 }, 500);
    await nextTick();
    assert.equal(requests.length, 1);
    assert.equal(cart.quoteReady, true);
    assert.equal(cart.items[0].product.price, product.price);
    cart.add(product);
    await nextTick();
    cart.add(product);
    await nextTick();
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(request => request.body.items[0].qty), [500, 1000, 1500]);
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(cart.displayTotal, 125000);
    assert.equal(cart.total, null);
    requests[2].resolve(response(1500, 150000));
    await nextTick();
    requests[1].resolve(response(1000, 1)); // Deliberately ignore abort, as a slow transport might.
    await nextTick();
    assert.equal(requests.length, 3); // Applying a quote must not trigger another request.
    assert.equal(cart.qty(1), 1500);
    assert.equal(cart.total, 150000);
    assert.equal(cart.displayLineTotal(1), 150000);
  } finally {
    app.unmount();
    if (previousApi === undefined) delete globalThis.useApiClient;
    else globalThis.useApiClient = previousApi;
  }
});
