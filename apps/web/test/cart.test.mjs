import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import {
  checkoutRedirect,
  decodeCart,
  cartKey,
  reconcileCart,
  nextCartQty,
} from "../app/utils/cart.ts";
import { deliveryEligibility } from "../app/utils/shop-settings.ts";

const product = {
  id: 1,
  name: "Яблоки",
  slug: "apples",
  price: 350000,
  priceQty: 1000,
  unit: "GRAM",
  min: 500,
  step: 300,
  images: [],
  category: { name: "Фрукты", slug: "fruit" },
};
const settings = {
  minDeliverySubtotal: 300000,
  deliveryEnabled: true,
  pickupEnabled: true,
};
const quote = (price, qty = 1100, subtotal = (price * qty) / 1000) => ({
  valid: true,
  token: String(price),
  error: null,
  subtotal,
  items: [
    {
      productId: 1,
      qty,
      product: { ...product, price },
      status: "AVAILABLE",
      lineTotal: subtotal,
    },
  ],
});
function store() {
  setActivePinia(createPinia());
  return useCartStore();
}

test("checkout redirects only after restore confirms an empty cart", () => {
  assert.equal(checkoutRedirect(false, 0), false);
  assert.equal(checkoutRedirect(false, 1), false);
  assert.equal(checkoutRedirect(true, 0), true);
  assert.equal(checkoutRedirect(true, 1), false);
});
test("restore never treats saved prices as a current quote", () => {
  const cart = store();
  assert.equal(cart.restored, false);
  assert.equal(cart.total, null);
  cart.restore([{ product, qty: 1100 }]);
  assert.equal(cart.restored, true);
  assert.equal(cart.quoteReady, false);
  assert.equal(cart.total, null);
  cart.applyQuote(quote(250000), cart.key);
  assert.equal(cart.total, 275000);
  assert.equal(cart.priceChanged, true);
});
for (const unit of ["GRAM", "PIECE", "PACK", "BUNCH"]) {
  test(`${unit}: repeated quick add follows 500 / 800 / 1100`, () => {
    const cart = store();
    for (const expected of [500, 800, 1100]) {
      assert.equal(cart.add({ ...product, unit }), true);
      assert.equal(cart.qty(1), expected);
    }
  });
}
test("other grids, upper bound and invalid legacy quantity are not silently rounded", () => {
  for (const [min, step, expected] of [
    [1, 1, [1, 2, 3]],
    [1000, 250, [1000, 1250, 1500]],
  ]) {
    let qty;
    for (const next of expected) {
      qty = nextCartQty(qty, { min, step });
      assert.equal(qty, next);
    }
  }
  assert.equal(nextCartQty(1000, product), null);
  assert.equal(nextCartQty(1000000, { min: 1, step: 1 }), null);
});
test("detail sets an explicit total; it never merges two invalid min-based portions", () => {
  const cart = store();
  cart.add(product);
  assert.equal(cart.put(product, 800), true);
  assert.equal(cart.qty(1), 800);
  cart.put(product, 800);
  assert.equal(cart.qty(1), 800);
  cart.add(product);
  assert.equal(cart.qty(1), 1100);
  assert.equal(cart.put(product, 1000), false);
  assert.equal(cart.qty(1), 1100);
});
test("price decrease/increase changes eligibility using only server subtotal", () => {
  const cart = store();
  cart.restore([{ product: { ...product, min: 1000, step: 1000 }, qty: 1000 }]);
  cart.applyQuote(quote(250000, 1000, 250000), cart.key);
  assert.equal(deliveryEligibility(cart.total, settings).delivery, false);
  assert.equal(deliveryEligibility(cart.total, settings).remaining, 50000);
  cart.applyQuote(quote(350000, 1000, 350000), cart.key);
  assert.equal(deliveryEligibility(cart.total, settings).delivery, true);
  assert.equal(
    deliveryEligibility(0, { ...settings, minDeliverySubtotal: 0 }).delivery,
    true,
  );
});
test("refresh invalidates eligibility without clearing items; retry restores server totals", () => {
  const cart = store();
  cart.restore([{ product, qty: 1100 }]);
  cart.applyQuote(quote(350000), cart.key);
  cart.invalidateQuote(); // Also the state retained on a failed request.
  assert.equal(cart.total, null);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.quoteReady, false);
  cart.applyQuote(quote(250000), cart.key);
  assert.equal(cart.total, 275000);
});
test("late quote cannot overwrite quantity edits or resurrect removed products", () => {
  const cart = store();
  cart.restore([{ product, qty: 1100 }]);
  const key = cart.key;
  cart.setQty(1, 800);
  assert.equal(cart.applyQuote(quote(250000), key), false);
  assert.equal(cart.qty(1), 800);
  cart.remove(1);
  assert.equal(cart.applyQuote(quote(250000), key), false);
  assert.equal(cart.count, 0);
});
test("unavailable and invalid-quantity lines remain visible, never silently removed/rounded", () => {
  const items = [{ product, qty: 1000 }];
  const result = reconcileCart(
    items,
    {
      ...quote(1),
      items: [
        {
          productId: 1,
          qty: 1000,
          product: null,
          status: "UNAVAILABLE",
          lineTotal: null,
        },
      ],
      valid: false,
      subtotal: null,
    },
    cartKey(items),
  );
  assert.deepEqual(result.items, items);
  const decoded = decodeCart(JSON.stringify(items));
  assert.equal(decoded.items[0].qty, 1000);
});
test("storage supports legacy/versioned rows and rejects malformed data safely", () => {
  const items = [{ product, qty: 1100 }];
  assert.deepEqual(decodeCart(JSON.stringify(items)).items, items);
  assert.deepEqual(
    decodeCart(JSON.stringify({ version: 1, items })).items,
    items,
  );
  for (const input of [
    "{",
    "{}",
    "[null]",
    '[{"product":null}]',
    JSON.stringify({ version: 99, items }),
  ]) {
    assert.equal(decodeCart(input).items.length, 0);
    assert.ok(decodeCart(input).warning);
  }
  assert.equal(decodeCart(null).warning, "");
});
