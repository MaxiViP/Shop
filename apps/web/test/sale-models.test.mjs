import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { useCartStore } from '../app/stores/cart.ts';
import { cartKey, decodeCart, previewTotal, validCartQty } from '../app/utils/cart.ts';
import { qtyText } from '../app/utils/qty.ts';
import { quickAddState } from '../app/utils/quick-add.ts';
import { deliveryEligibility } from '../app/utils/shop-settings.ts';
const whole = { id: 1, name: 'Отруб на кости', slug: 'bone-cut', price: 165000, priceQty: 1000,
  unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', wholeLabel: 'кусок', min: 1, step: 1, portionQty: 1,
  category: { slug: 'meat', name: 'Мясо' }, images: [] };
test('whole pieces retain counts, unknown totals, buyer limits and sale mode after storage round-trip', () => {
  const cart = useCartStore(createPinia());
  cart.restore([]);
  for (const count of [1, 2, 3]) { assert.equal(cart.add(whole), true); assert.equal(cart.qty(1), count); }
  assert.equal(previewTotal(whole, 3), null);
  assert.equal(cart.setWeightLimits(1, 1000, 2000), true);
  const restored = decodeCart(JSON.stringify({ version: 1, items: cart.items }));
  assert.equal(restored.items[0].quantityUnit, 'PIECE');
  assert.equal(restored.items[0].product.priceUnit, 'GRAM');
  assert.equal(restored.items[0].weightMaxGrams, 2000);
  assert.equal(restored.items[0].qty, 3);
  assert.equal(qtyText('PIECE', 3, whole), '3 куска');
  assert.equal(quickAddState(whole, 0).label, 'Добавить 1 кусок');
});
test('packs and bunches have count controls and correct Russian labels', () => {
  for (const [unit, singular, plural] of [['BUNCH', '1 пучок', '3 пучка'], ['PACK', '1 упаковка', '3 упаковки']]) {
    const product = { ...whole, unit, priceUnit: unit, saleModel: unit, wholeLabel: null, priceQty: 1, price: 12300 };
    const cart = useCartStore(createPinia());
    for (const count of [1, 2, 3]) { cart.add(product); assert.equal(cart.qty(1), count); }
    assert.equal(qtyText(unit, 1), singular);
    assert.equal(qtyText(unit, 3), plural);
    assert.equal(previewTotal(product, 3), 36900);
  }
});
test('invalid whole counts and limits cannot replace an existing cart selection', () => {
  const cart = useCartStore(createPinia());
  cart.add(whole);
  for (const qty of [-1, 0, 1.5, 101]) { assert.equal(validCartQty(qty, whole), false); assert.equal(cart.put(whole, qty), false); }
  assert.equal(cart.setWeightLimits(1, 2000, 1000), false);
  assert.equal(cart.setWeightLimits(1, -1, null), false);
  assert.equal(cart.qty(1), 1);
});
test('a verified unknown-weight quote remains orderable with no invented subtotal', () => {
  const cart = useCartStore(createPinia());
  cart.restore([{ product: whole, qty: 1, quantityUnit: 'PIECE' }]);
  cart.applyQuote({ valid: true, pendingWeight: true, token: 'quote', subtotal: null, knownSubtotal: 0, error: null,
    items: [{ productId: 1, qty: 1, product: whole, status: 'AVAILABLE', lineTotal: null }] }, cart.key);
  assert.equal(cart.quoteReady, true);
  assert.equal(cart.quote.valid, true);
  assert.equal(cart.total, null);
  assert.equal(deliveryEligibility(null, { deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 100000 }).pickup, true);
});
test('stale grams cannot be silently changed to pieces by plus or minus', () => {
  const cart = useCartStore(createPinia());
  const grams = { ...whole, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', min: 1, step: 1, portionQty: 1 };
  cart.restore([{ product: grams, qty: 5, quantityUnit: 'GRAM' }]);
  assert.equal(cart.add(whole), false);
  assert.equal(cart.subtract(whole), false);
  assert.equal(cart.qty(1), 5);
  assert.equal(cart.put(whole, 2), true); // Explicitly chosen new total.
  assert.equal(cart.items[0].quantityUnit, 'PIECE');
  assert.equal(cart.qty(1), 2);
});
test('preview never presents positive quantities as free', () => {
  assert.equal(previewTotal({ ...whole, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', price: 1, priceQty: 1000 }, 1), null);
});
test('stale quantityUnit remains part of the quote identity until explicitly corrected', () => {
  const fixed = { ...whole, priceUnit: 'PIECE', saleModel: 'PIECE_FIXED', priceQty: 1 };
  assert.notEqual(cartKey([{ product: fixed, qty: 2, quantityUnit: 'GRAM' }]), cartKey([{ product: fixed, qty: 2, quantityUnit: 'PIECE' }]));
});
test('explicit same-number correction from grams to pieces refreshes product data and quote identity', () => {
  const cart = useCartStore(createPinia());
  const grams = { ...whole, unit: 'GRAM', saleModel: 'WEIGHT_LOOSE', min: 1, step: 1, portionQty: 1 };
  const pieces = { ...whole, priceUnit: 'PIECE', priceQty: 1, saleModel: 'PIECE_FIXED' };
  cart.restore([{ product: grams, qty: 1 }]);
  const before = cart.key;
  assert.equal(cart.put(pieces, 1), true);
  assert.equal(cart.items[0].product.unit, 'PIECE');
  assert.notEqual(cart.key, before);
  assert.equal(cart.quoteReady, false);
});
