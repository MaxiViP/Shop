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
  previewTotal,
} from "../app/utils/cart.ts";
import { manualQuantity, quantityErrors } from "../app/utils/assembly.ts";
import { qtyText } from "../app/utils/qty.ts";
import { quickAddState } from "../app/utils/quick-add.ts";
import { deliveryEligibility } from "../app/utils/shop-settings.ts";

const product = {
  id: 1,
  name: "Яблоки",
  slug: "apples",
  price: 350000,
  priceQty: 1000,
  unit: "GRAM",
  min: 500,
  step: 100,
  portionQty: 500,
  images: [],
  category: { name: "Фрукты", slug: "fruit" },
};

test("quick-add starts with a product name and a formatted portion in its accessible label", () => {
  assert.deepEqual(quickAddState(product, 0), {
    added: false,
    label: "В корзину",
    ariaLabel: "Добавить Яблоки в корзину: 500 г",
  });
});

for (const [unit, qty, portionQty, label, portion] of [
  ["GRAM", 500, 500, "500 г", "500 г"],
  ["GRAM", 1000, 500, "1 кг", "500 г"],
  ["GRAM", 1500, 500, "1,5 кг", "500 г"],
  ["PIECE", 3, 2, "3 шт.", "2 шт."],
  ["PACK", 2, 1, "2 уп.", "1 уп."],
  ["BUNCH", 2, 1, "2 пуч.", "1 пуч."],
]) {
  test(`quick-add button displays ${label} and announces the next portion`, () => {
    assert.deepEqual(quickAddState({ ...product, unit, portionQty }, qty), {
      added: true,
      label,
      ariaLabel: `В корзине ${label}. Добавить ещё ${portion}`,
    });
  });
}
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
  test(`${unit}: quick add uses a portion, independent of manual step`, () => {
    const cart = store();
    for (const expected of [500, 1000, 1500]) {
      assert.equal(cart.add({ ...product, unit }), true);
      assert.equal(cart.qty(1), expected);
    }
  });
}
test("other grids, upper bound and invalid legacy quantity are not silently rounded", () => {
  for (const [min, step, expected] of [
    [1, 1, [1, 2, 3]],
    [1000, 250, [1000, 2000, 3000]],
  ]) {
    let qty;
    for (const next of expected) {
      qty = nextCartQty(qty, { min, step, portionQty: min });
      assert.equal(qty, next);
    }
  }
  assert.equal(nextCartQty(1001, product), null);
  assert.equal(nextCartQty(1000000, { min: 1, step: 1, portionQty: 1 }), null);
});
test("detail sets a desired total while card adds a portion", () => {
  const cart = store();
  cart.add(product);
  assert.equal(cart.put(product, 800), true);
  assert.equal(cart.qty(1), 800);
  cart.put(product, 800);
  assert.equal(cart.qty(1), 800);
  cart.add(product);
  assert.equal(cart.qty(1), 1300);
  assert.equal(cart.put(product, 1001), false);
  assert.equal(cart.qty(1), 1300);
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

for (const config of [
  { unit: 'GRAM', min: 500, step: 100, portionQty: 500, quick: [500, 1000, 1500], manual: [500, 600, 700] },
  { unit: 'GRAM', min: 500, step: 250, portionQty: 1000, quick: [1000, 2000, 3000], manual: [500, 750, 1000] },
  { unit: 'PIECE', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
  { unit: 'PIECE', min: 1, step: 1, portionQty: 2, quick: [2, 4, 6], manual: [1, 2, 3] },
  { unit: 'PIECE', min: 2, step: 1, portionQty: 3, quick: [3, 6, 9], manual: [2, 3, 4] },
  { unit: 'PACK', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
  { unit: 'BUNCH', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
]) {
  test(`store operations: ${config.unit}, min=${config.min}, step=${config.step}, portion=${config.portionQty}`, () => {
    const cart = store();
    const item = { ...product, ...config };
    assert.deepEqual(quantityErrors(item), {});
    for (const expected of config.quick) {
      assert.equal(cart.add(item), true);
      assert.equal(cart.qty(1), expected);
    }
    assert.equal(cart.put(item, config.min), true);
    for (const expected of config.manual.slice(1)) {
      assert.equal(cart.setQty(1, manualQuantity(cart.qty(1), item, 1)), true);
      assert.equal(cart.qty(1), expected);
    }
    const desired = cart.qty(1);
    assert.equal(cart.put(item, desired), true);
    assert.equal(cart.qty(1), desired);
    for (const expected of config.manual.slice(0, -1).reverse()) {
      cart.setQty(1, manualQuantity(cart.qty(1), item, -1));
      assert.equal(cart.qty(1), expected);
    }
    assert.equal(manualQuantity(cart.qty(1), item, -1), config.min);
  });
}

test('maximum lines and quantity reject changes without invalidating an existing quote', () => {
  const cart = store();
  for (let id = 1; id <= 50; id++) assert.equal(cart.add({ ...product, id }), true);
  assert.equal(cart.add({ ...product, id: 51 }), false);
  assert.equal(cart.count, 50);
  assert.equal(cart.add(product), true);
  assert.equal(cart.put(product, 1000000), true);
  assert.equal(cart.add(product), false);
  assert.equal(cart.qty(1), 1000000);
  for (const value of [0, -1, 501, 1.5, 1000001, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(cart.setQty(1, value), false);
  cart.clear();
  cart.restore([{ product, qty: 1000000 }]);
  cart.applyQuote(quote(1, 1000000, 1000), cart.key);
  assert.equal(cart.add(product), false);
  assert.equal(cart.quoteReady, true);
});

test('legacy cart backfills only a missing portion and keeps saved quantities for server reconciliation', () => {
  const legacy = { ...product };
  delete legacy.portionQty;
  for (const qty of [500, 700, 501]) {
    const items = [{ product: legacy, qty }];
    for (const data of [items, { version: 1, items }]) {
      const decoded = decodeCart(JSON.stringify(data));
      assert.equal(decoded.warning, '');
      assert.equal(decoded.items[0].qty, qty);
      assert.equal(decoded.items[0].product.portionQty, 500);
    }
  }
  const decoded = decodeCart(JSON.stringify([{ product: { ...legacy, step: 1 }, qty: 500 }]));
  const cart = store();
  cart.restore(decoded.items);
  assert.equal(cart.add(cart.items[0].product), true);
  assert.equal(cart.qty(1), 1000);
  const next = { ...quote(350000, 1000), items: [{ ...quote(350000, 1000).items[0], product: { ...product, portionQty: 1000 } }] };
  cart.applyQuote(next, cart.key);
  assert.equal(cart.items[0].product.portionQty, 1000);
  assert.equal(cart.add(cart.items[0].product), true);
  assert.equal(cart.qty(1), 2000);
  const roundTrip = decodeCart(JSON.stringify({ version: 1, items: cart.items }));
  assert.equal(roundTrip.items[0].product.portionQty, 1000);
  for (const portionQty of [0, -1, 0.5, '500', null]) {
    const invalid = decodeCart(JSON.stringify([{ product: { ...product, portionQty }, qty: 500 }]));
    assert.equal(invalid.items.length, 0);
    assert.ok(invalid.warning);
  }
});

test('price previews use exact backend rounding and report limits', () => {
  for (const [price, priceQty, expected] of [[15000, 500, [15000, 30000, 45000]], [19900, 1000, [9950, 19900, 29850]]]) {
    for (const [index, qty] of [500, 1000, 1500].entries())
      assert.equal(previewTotal({ ...product, price, priceQty }, qty), expected[index]);
  }
  assert.equal(previewTotal({ ...product, price: 1, priceQty: 1000 }, 500), 1);
  assert.equal(previewTotal({ ...product, price: 100000000, priceQty: 1 }, 1000000), null);
  assert.equal(previewTotal(product, 501), null);
});

test('quantity formatting keeps whole grams without losing precision in kilograms', () => {
  for (const [qty, text] of [[500, '500 г'], [1000, '1 кг'], [1500, '1,5 кг'], [1250, '1,25 кг'], [1001, '1,001 кг'], [1005, '1,005 кг']])
    assert.equal(qtyText('GRAM', qty), text);
  for (const [unit, text] of [['PIECE', '2 шт.'], ['PACK', '2 уп.'], ['BUNCH', '2 пуч.']])
    assert.equal(qtyText(unit, 2), text);
});
