import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogMoney, money } from '../app/utils/money.ts';
import { saleExplanation } from '../app/utils/sale.ts';

test('catalog preserves all kopecks including amounts below one ruble', () => {
  for (const [amount, expected] of [[1, '0,01 ₽'], [49, '0,49 ₽'], [19950, '199,5 ₽'], [19999, '199,99 ₽'], [20000, '200 ₽']]) {
    assert.equal(catalogMoney(amount), expected);
    assert.equal(catalogMoney(amount), money(amount));
  }
});
test('only whole goods or bunches priced by weight explain approximate weight', () => {
  for (const [unit, saleModel] of [['GRAM', 'WEIGHT_LOOSE'], ['GRAM', 'CUT_TO_WEIGHT'], ['PIECE', 'PIECE_FIXED'], ['PACK', 'PACK'], ['BUNCH', 'BUNCH']]) {
    assert.equal(saleExplanation({ unit, saleModel, priceUnit: unit }), null);
  }
  assert.match(saleExplanation({ unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceUnit: 'GRAM' }), /поштучно, целиком/);
  assert.match(saleExplanation({ unit: 'BUNCH', saleModel: 'BUNCH', priceUnit: 'GRAM' }), /пучками/);
});
