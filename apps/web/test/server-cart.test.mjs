import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import { useCartActions } from "../app/composables/useCartActions.ts";

const product = {
  id: 1, name: "Apples", slug: "apples", price: 350000, priceQty: 1000,
  unit: "GRAM", min: 500, step: 100, portionQty: 500, images: [],
  category: { name: "Fruit", slug: "fruit" },
};

function fixture() {
  setActivePinia(createPinia());
  const cart = useCartStore();
  const actions = useCartActions();
  let revision = 0;
  let rows = [];
  const snapshot = () => ({
    revision: String(revision),
    items: rows.map(({ id, qty }) => ({
      productId: id, qty, product, status: "AVAILABLE",
      lineTotal: (product.price * qty) / product.priceQty,
    })),
    products: rows.length ? [product] : [],
    subtotal: rows.reduce((total, row) =>
      total + (product.price * row.qty) / product.priceQty, 0),
    valid: true, error: null, token: String(revision),
  });
  const api = {
    get: async () => snapshot(),
    change: async ({ revision: expected, kind, productId, qty }) => {
      if (expected !== String(revision)) throw { statusCode: 409 };
      if (kind === "clear") rows = [];
      else if (kind === "remove") rows = rows.filter(row => row.id !== productId);
      else if (kind === "set" || kind === "add") {
        const old = rows.find(row => row.id === productId);
        if (old) old.qty = kind === "add" ? old.qty + qty : qty;
        else rows.push({ id: productId, qty });
      }
      revision++;
      return snapshot();
    },
  };
  cart.bindServer(api);
  cart.beginServer(1);
  return { cart, actions, api, snapshot, botSet(qty) {
    rows = qty ? [{ id: 1, qty }] : [];
    revision++;
  } };
}

test("fresh authenticated product route waits for restore, then sets desired total and Header quote", async () => {
  const f = fixture();
  assert.equal(f.cart.restored, false);
  assert.equal(await f.actions.put(product, 500), false);
  f.cart.applyServer(f.snapshot(), 1);
  assert.equal(f.cart.restored, true);
  assert.equal(await f.actions.put(product, 500), true);
  assert.equal(f.cart.count, 1);
  assert.equal(f.cart.qty(1), 500);
  assert.equal(f.cart.displayTotal, 175000);
  assert.equal(f.cart.quoteReady, true);
  assert.equal(await f.actions.put(product, 800), true);
  assert.equal(f.cart.count, 1);
  assert.equal(f.cart.qty(1), 800);
  assert.equal(f.cart.displayTotal, 280000);
  assert.equal(await f.actions.add(product), true);
  assert.equal(f.cart.qty(1), 1300);
});

test("stale website mutation refreshes bot changes without overwriting them", async () => {
  const f = fixture();
  f.cart.applyServer(f.snapshot(), 1);
  assert.equal(await f.actions.put(product, 500), true);
  f.botSet(1250);
  assert.equal(await f.actions.put(product, 800), false);
  assert.equal(f.cart.qty(1), 1250);
  assert.equal(f.cart.displayTotal, 437500);
  assert.equal(await f.actions.put(product, 1500), true);
  assert.equal(f.cart.qty(1), 1500);
});

test("bot refresh, web remove, and web clear use authoritative snapshots", async () => {
  const f = fixture();
  f.cart.applyServer(f.snapshot(), 1);
  f.botSet(1000);
  assert.equal(await f.cart.refreshServer(), true);
  assert.equal(f.cart.qty(1), 1000);
  assert.equal(await f.actions.remove(1), true);
  assert.equal(f.cart.count, 0);
  f.botSet(500);
  assert.equal(await f.cart.refreshServer(), true);
  assert.equal(await f.actions.clear(), true);
  assert.equal(f.cart.count, 0);
  assert.equal(f.cart.total, 0);
});
