import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import {
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
  priceStatus: 'ESTIMATED',
  name: "Яблоки",
  slug: "apples",
  price: 350000,
  priceQty: 1000,
  unit: "GRAM",
  min: 500,
  step: 100,
  portionQty: 500,
  isSeasonal: false,
  isHit: false,
  seasonalStartsAt: null,
  seasonalEndsAt: null,
  images: [],
  category: { name: "Фрукты", slug: "fruit" },
  marketPoint: null,
};

test("quick-add starts with a product name and a formatted portion in its accessible label", () => {
  assert.deepEqual(quickAddState(product, 0), {
    added: false,
    label: "Добавить 500 г",
    ariaLabel: "Добавить Яблоки в корзину: 500 г",
  });
});

for (const [unit, qty, portionQty, label, portion] of [
  ["GRAM", 500, 500, "500 г", "100 г"],
  ["GRAM", 1000, 500, "1 кг", "100 г"],
  ["GRAM", 1500, 500, "1,5 кг", "100 г"],
  ["PIECE", 3, 2, "3 шт.", "1 шт."],
  ["PACK", 2, 1, "2 упаковки", "1 упаковку"],
  ["BUNCH", 2, 1, "2 пучка", "1 пучок"],
]) {
  test(`quick-add button displays ${label} and announces the next portion`, () => {
    assert.deepEqual(quickAddState({ ...product, unit, portionQty, step: unit === 'GRAM' ? 100 : 1 }, qty), {
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
test("saved guest cart survives the first add after restoration", () => {
  const savedProduct = { ...product, id: 2, name: "Груши", slug: "pears" };
  const cart = store();
  assert.equal(cart.restored, false);
  const saved = decodeCart(
    JSON.stringify({ version: 1, items: [{ product: savedProduct, qty: 500 }] }),
  );
  cart.restore(saved.items, saved.warning);
  assert.equal(cart.restored, true);
  assert.equal(cart.qty(savedProduct.id), 500);
  assert.equal(cart.add(product), true);
  assert.deepEqual(cart.items.map((item) => item.product.id), [2, 1]);
  assert.equal(cart.quoteReady, false);
});
for (const unit of ["GRAM", "PIECE", "PACK", "BUNCH"]) {
  test(`${unit}: first add uses a portion and later controls use the step`, () => {
    const cart = store();
    const item = { ...product, unit, ...(unit === 'GRAM' ? {} : { min: 1, step: 1, portionQty: 1 }) };
    for (const expected of unit === 'GRAM' ? [500, 600, 700] : [1, 2, 3]) {
      assert.equal(cart.add(item), true);
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
  assert.equal(cart.qty(1), 900);
  assert.equal(cart.put(product, 1001), false);
  assert.equal(cart.qty(1), 900);
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
  { unit: 'GRAM', min: 500, step: 100, portionQty: 500, quick: [500, 600, 700], manual: [500, 600, 700] },
  { unit: 'GRAM', min: 500, step: 250, portionQty: 1000, quick: [1000, 1250, 1500], manual: [500, 750, 1000] },
  { unit: 'PIECE', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
  { unit: 'PIECE', min: 1, step: 1, portionQty: 2, quick: [2, 3, 4], manual: [1, 2, 3] },
  { unit: 'PIECE', min: 2, step: 1, portionQty: 3, quick: [3, 4, 5], manual: [2, 3, 4] },
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
  assert.equal(cart.qty(1), 501);
  const next = { ...quote(350000, 501), items: [{ ...quote(350000, 501).items[0], product: { ...product, step: 1, portionQty: 1000 } }] };
  cart.applyQuote(next, cart.key);
  assert.equal(cart.items[0].product.portionQty, 1000);
  assert.equal(cart.add(cart.items[0].product), true);
  assert.equal(cart.qty(1), 502);
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
  for (const [unit, text] of [['PIECE', '2 шт.'], ['PACK', '2 упаковки'], ['BUNCH', '2 пучка']])
    assert.equal(qtyText(unit, 2), text);
});

for (const [unit, min, step, portionQty, start, expected] of [
  ["GRAM", 500, 100, 500, 1500, [1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600, 500, 0]],
  ["GRAM", 500, 100, 500, 1300, [1200, 1100, 1000, 900, 800, 700, 600, 500, 0]],
  ["GRAM", 500, 250, 1000, 1500, [1250, 1000, 750, 500, 0]],
  ["PIECE", 1, 1, 1, 3, [2, 1, 0]],
  ["PIECE", 2, 1, 3, 6, [5, 4, 3, 2, 0]],
  ["PACK", 1, 1, 1, 2, [1, 0]],
  ["BUNCH", 1, 1, 1, 1, [0]],
]) {
  test(`card minus: ${unit}, portion ${portionQty}, preserves manual quantities until below min`, () => {
    const cart = store();
    const current = { ...product, unit, min, step, portionQty };
    cart.restore([{ product: current, qty: start }]);
    for (const qty of expected) {
      const key = cart.key;
      assert.equal(cart.subtract(current), true);
      assert.equal(cart.qty(current.id), qty);
      assert.equal(cart.quoteReady, false);
      assert.equal(cart.total, null);
      assert.notEqual(cart.key, key);
    }
    assert.equal(cart.count, 0);
    assert.equal(cart.subtract(current), false);
  });
}

test("card minus refuses invalid legacy quantities without rounding or removing them", () => {
  const cart = store();
  cart.restore([{ product, qty: 1001 }]);
  assert.equal(cart.subtract(product), false);
  assert.equal(cart.qty(product.id), 1001);
  cart.restore([{ product, qty: 1500 }]);
  cart.applyQuote(quote(350000, 1500, 525000), cart.key);
  assert.equal(cart.subtract({ ...product, portionQty: 501 }), false);
  assert.equal(cart.qty(product.id), 1500);
  assert.equal(cart.total, 525000);
});

test("card and header totals stay server-authoritative through portion edits", () => {
  const cart = store();
  cart.restore([{ product, qty: 1500 }]);
  cart.applyQuote(quote(350000, 1500, 12345), cart.key);
  assert.equal(cart.total, 12345);
  assert.equal(cart.quoteLine(product.id).lineTotal, 12345);
  const previousKey = cart.key;
  cart.subtract(product);
  assert.equal(cart.total, null);
  assert.equal(cart.quoteLine(product.id), undefined);
  assert.equal(cart.applyQuote(quote(350000, 1500, 12345), previousKey), false);
  cart.applyQuote(quote(350000, 1400, 90000), cart.key);
  assert.equal(cart.total, 90000);
  assert.equal(cart.quoteLine(product.id).lineTotal, 90000);
});

for (const qty of [600, 700]) {
  test(`card minus reduces manual ${qty}g by the step and retains the minimum`, () => {
    const cart = store();
    cart.restore([{ product, qty }]);
    assert.equal(cart.subtract(product), true);
    assert.equal(cart.qty(1), qty - 100);
    assert.equal(cart.count, 1);
  });
}
test("card plus preserves manually chosen 700g: 700 + step 100 = 800", () => {
  const cart = store();
  cart.restore([{ product, qty: 700 }]);
  assert.equal(cart.add(product), true);
  assert.equal(cart.qty(product.id), 800);
  assert.equal(manualQuantity(800, product, 1), 900);
});

test("same-quantity put preserves fresh quote and reconciled server product, not catalog prices", () => {
  const cart = store();
  cart.restore([{ product, qty: 1000 }]);
  cart.applyQuote(quote(250000, 1000, 250000), cart.key);
  const reconciled = cart.items[0].product;
  const token = cart.quote.token;
  // The catalogue snapshot has another price. A quantity no-op must not install it.
  assert.equal(cart.put({ ...product }, 1000), true);
  assert.equal(cart.quoteReady, true);
  assert.equal(cart.items[0].product, reconciled);
  assert.equal(cart.items[0].product.price, 250000);
  assert.equal(cart.total, 250000);
  assert.equal(cart.quote.token, token);
  assert.equal(cart.put(product, 1001), false);
  assert.equal(cart.quoteReady, true);
  // Actual server reconciliation still updates price and warnings.
  cart.applyQuote(quote(200000, 1000, 200000), cart.key);
  assert.equal(cart.items[0].product.price, 200000);
  assert.equal(cart.total, 200000);
  assert.equal(cart.priceChanged, true);
  assert.equal(cart.put(product, 1200), true);
  assert.equal(cart.quoteReady, false);
  assert.equal(cart.total, null);
});

test("display amounts retain server values while current totals remain unavailable", () => {
  const cart = store();
  cart.restore([{ product, qty: 500 }]);
  assert.equal(cart.displayTotal, null);
  assert.equal(cart.displayLineTotal(1), null);
  cart.applyQuote(quote(350000, 500, 125000), cart.key);
  assert.equal(cart.displayTotal, 125000);
  assert.equal(cart.displayLineTotal(1), 125000);
  cart.add(product);
  assert.equal(cart.displayTotal, 125000);
  assert.equal(cart.displayLineTotal(1), 125000);
  assert.equal(cart.total, null);
  assert.equal(cart.quoteReady, false);
  assert.equal(cart.lineTotal(cart.items[0]), null);
  cart.applyQuote(quote(350000, 600, 150000), cart.key);
  assert.equal(cart.displayTotal, 150000);
  assert.equal(cart.displayLineTotal(1), 150000);
  // No server amount exists for a newly added product.
  cart.add({ ...product, id: 2 });
  assert.equal(cart.displayLineTotal(2), null);
  cart.remove(1);
  assert.equal(cart.displayLineTotal(1), null);
  cart.clear();
  assert.equal(cart.displayTotal, null);
  assert.equal(cart.displayLineTotal(1), null);
  cart.restore([{ product, qty: 500 }]);
  assert.equal(cart.displayTotal, null);
});

test("an invalid fresh quote replaces previous displayed amounts and remains ineligible", () => {
  const cart = store();
  cart.restore([{ product, qty: 500 }]);
  cart.applyQuote(quote(350000, 500, 125000), cart.key);
  cart.applyQuote({ valid: false, token: null, error: null, subtotal: null,
    items: [{ productId: 1, qty: 500, product: null, status: "UNAVAILABLE", lineTotal: null }] }, cart.key);
  assert.equal(cart.count, 1);
  assert.equal(cart.displayTotal, null);
  assert.equal(cart.displayLineTotal(1), null);
  assert.equal(cart.total, null);
  assert.equal(cart.quote.valid, false);
});
