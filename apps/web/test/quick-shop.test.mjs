import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { useCartStore } from '../app/stores/cart.ts';
import { quickShopRows, quickShopChange, quickShopUndo, quickShopContext, quickShopOrderId } from '../app/utils/quick-shop.ts';

const tomato = { id: 1, name: 'Помидоры', unit: 'GRAM', priceQty: 1000, price: 32000, min: 250, step: 250, portionQty: 500 };
const fish = { id: 2, name: 'Рыба', unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000, price: 65000, min: 1, step: 1, portionQty: 1, estimatedWeightGrams: 1500 };
const line = (product, qty, lineTotal) => ({ productId: product.id, qty, product, lineTotal, status: 'AVAILABLE' });

test('acknowledged quantities show actual addition and server money difference', () => {
  const text = quickShopChange(tomato, line(tomato, 500, 16000), line(tomato, 750, 24000));
  assert.match(text, /добавлено \+250 г · \+80 ₽/);
  assert.match(text, /В корзине 750 г/);
  assert.match(quickShopChange(tomato, line(tomato, 250, 8000), undefined), /убрано 250 г · −80 ₽.*удалён/);
});

test('repricing, unknown whole weight and estimated weight changes cannot be shown as addition cost', () => {
  assert.doesNotMatch(quickShopChange(tomato, line(tomato, 500, 16000), line({ ...tomato, price: 40000 }, 750, 30000)), /₽/);
  assert.doesNotMatch(quickShopChange(fish, line(fish, 2, null), line(fish, 3, null)), /₽/);
  assert.doesNotMatch(quickShopChange(fish, line(fish, 2, 195000), line({ ...fish, estimatedWeightGrams: 2000 }, 3, 390000)), /₽/);
});

test('grams and pieces are never subtracted across changed sale units', () => {
  assert.match(quickShopChange(fish, line({ ...fish, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE' }, 1000, 65000), line(fish, 1, null)), /Условия товара изменились/);
  assert.doesNotMatch(quickShopChange(fish, { ...line(fish, 1000, null), quantityUnit: 'GRAM' }, { ...line(fish, 1, null), quantityUnit: 'PIECE' }), /999/);
});

test('current cart metadata and unavailable lines survive suggestions and filtering', () => {
  const suggestions = [{ product: tomato, source: 'frequent', suggestedQty: 500, lineTotal: 16000 }];
  const fresh = { ...tomato, price: 40000 };
  const items = [{ product: fresh, qty: 750 }, { product: fish, qty: 1 }];
  const lines = [line(fresh, 750, 30000), { ...line(fish, 1, null), status: 'UNAVAILABLE' }];
  assert.equal(quickShopRows(suggestions, items, lines, 'all', [1])[0].product.price, 40000);
  assert.equal(quickShopRows(suggestions, items, lines, 'cart', [1]).length, 2);
  assert.equal(quickShopRows(suggestions, items, lines, 'favorites', [1]).length, 1);
  assert.equal(quickShopRows(suggestions, items, lines, 'all', [1])[1].line.status, 'UNAVAILABLE');
});

test('undo changes only an acknowledged product and preserves whole-weight limits', () => {
  const before = { ...line(fish, 1, null), quantityUnit: 'PIECE', weightMinGrams: 1000, weightMaxGrams: 1800 };
  const after = { ...before, qty: 2 };
  assert.deepEqual(quickShopUndo({ productId: 2, before, after }, after), {
    kind: 'set', productId: 2, qty: 1, quantityUnit: 'PIECE', weightMinGrams: 1000, weightMaxGrams: 1800,
  });
  assert.deepEqual(quickShopUndo({ productId: 2, before, after: undefined }, undefined), {
    kind: 'set', productId: 2, qty: 1, quantityUnit: 'PIECE', weightMinGrams: 1000, weightMaxGrams: 1800,
  });
  assert.deepEqual(quickShopUndo({ productId: 2, before: undefined, after }, after), { kind: 'remove', productId: 2 });
  assert.equal(quickShopUndo({ productId: 2, before, after: before }, before), null);
});

test('undo refuses intervening quantities, weight preferences, sale terms and unavailable lines', () => {
  const before = line(tomato, 500, 16000), after = line(tomato, 750, 24000);
  const undo = { productId: 1, before, after };
  for (const current of [line(tomato, 1000, 32000), undefined,
    { ...after, weightMaxGrams: 1200 }, { ...after, status: 'UNAVAILABLE' },
    { ...after, quantityUnit: 'PIECE' }, line({ ...tomato, min: 750 }, 750, 24000),
    line({ ...tomato, saleModel: 'CUT_TO_WEIGHT' }, 750, 24000),
    line({ ...tomato, priceUnit: 'PIECE' }, 750, 24000)]) {
    assert.equal(quickShopUndo(undo, current), null);
  }
  assert.equal(quickShopUndo({ productId: 1, before, after: undefined }, after), null);
  assert.equal(quickShopUndo({ productId: 1, before: { ...before, status: 'INVALID_QUANTITY' }, after: undefined }, undefined), null);
  assert.deepEqual(quickShopUndo(undo, line({ ...tomato, price: 40000 }, 750, 30000)), {
    kind: 'set', productId: 1, qty: 500, quantityUnit: 'GRAM',
  });
});

test('undo uses the fresh cart revision, preserves other products and does not replay an unknown response', async () => {
  setActivePinia(createPinia());
  const cart = useCartStore();
  let revision = 'fresh', rows = [line(tomato, 750, 24000), line(fish, 2, null)];
  const requests = [];
  let loseResponse = false;
  const snapshot = () => ({ revision, items: rows, products: rows.map(row => row.product),
    subtotal: null, valid: true, error: null, token: revision });
  cart.bindServer({ get: async () => snapshot(), change: async input => {
    requests.push(input);
    assert.equal(input.revision, revision);
    rows = rows.map(row => row.productId === input.productId ? { ...row, qty: input.qty } : row);
    revision += '-next';
    if (loseResponse) throw new Error('response lost after server commit');
    return snapshot();
  } });
  cart.beginServer(7);
  cart.applyServer({ ...snapshot(), revision: 'old' }, 7);
  const undo = { productId: 1, before: line(tomato, 500, 16000), after: line(tomato, 750, 24000) };
  assert.equal(await cart.refreshServer(), true);
  assert.equal(await cart.changeServer(quickShopUndo(undo, cart.quoteLine(1))), true);
  assert.equal(requests[0].revision, 'fresh');
  assert.equal(cart.qty(1), 500);
  assert.equal(cart.qty(2), 2);

  const nextUndo = { productId: 1, before: line(tomato, 750, 24000), after: cart.quoteLine(1) };
  loseResponse = true;
  assert.equal(await cart.changeServer(quickShopUndo(nextUndo, cart.quoteLine(1))), false);
  assert.equal(requests.length, 2);
  assert.equal(await cart.refreshServer(), true);
  assert.equal(cart.qty(1), 750);
  assert.equal(requests.length, 2);
  assert.equal(quickShopUndo(nextUndo, cart.quoteLine(1)), null);
});

test('navigation context contains no cart or prices and rejects invalid stored values', () => {
  assert.deepEqual(quickShopContext(JSON.stringify({ version: 1, filter: 'favorites', query: 'Помидоры', scroll: 1234,
    items: [{ qty: 999 }], subtotal: 1 })), { filter: 'favorites', query: 'Помидоры', scroll: 1234 });
  for (const value of [null, '', '{', '[]', 'null', '{"version":1}',
    JSON.stringify({ version: 1, filter: 'other', query: '', scroll: 0 }),
    JSON.stringify({ version: 1, filter: 'all', query: 'a'.repeat(101), scroll: 0 }),
    JSON.stringify({ version: 1, filter: 'all', query: '', scroll: -1 }),
    JSON.stringify({ version: 1, filter: 'cart', query: '', scroll: 1_000_001 })]) {
    assert.equal(quickShopContext(value), null);
  }
});

test('repeat links accept one bounded order id; no query value is treated as a mutation', () => {
  assert.equal(quickShopOrderId('128'), 128);
  assert.equal(quickShopOrderId('2147483647'), 2147483647);
  for (const value of ['0', '-1', '1.2', '1e3', '001', '2147483648', '99999999999', ['128'], 128, undefined, null]) {
    assert.equal(quickShopOrderId(value), null);
  }
});
