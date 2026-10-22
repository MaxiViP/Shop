import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { variableWeight } from '../../api/src/product/sale.ts';

const source = await readFile(new URL('../app/utils/weigh.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('require', 'exports', code)(name => { assert.equal(name, './sale'); return { variableWeight }; }, module.exports);
const { weighInput, nextWeighItem } = module.exports;

test('weighing keeps exact integer grams and rejects decimal, scientific and excessive input', () => {
  const item = { unit: 'GRAM' };
  assert.deepEqual(weighInput(item, '782', []), { status: 'PICKED', actualQty: 782 });
  assert.deepEqual(weighInput(item, '1000000', []), { status: 'PICKED', actualQty: 1000000 });
  for (const text of ['', '0', '-1', '782.5', '1e3', '1000001', '00782']) assert.equal(weighInput(item, text, []), null, text);
});
test('whole goods require one valid weight for each actual piece and cap the combined grams', () => {
  const item = { unit: 'PIECE', priceUnit: 'GRAM' };
  assert.deepEqual(weighInput(item, '2', ['700', '800']), { status: 'PICKED', actualQty: 2, pieceWeights: [700, 800] });
  for (const weights of [[], ['700'], ['700', ''], ['700', '0'], ['700', '800.5'], ['700000', '800000']]) assert.equal(weighInput(item, '2', weights), null);
  assert.equal(weighInput(item, '101', Array(101).fill('1')), null);
});
test('next weighing position wraps, skipping handled goods and open buyer decisions', () => {
  const items = [{ id: 1, status: 'PENDING' }, { id: 2, status: 'PICKED' }, { id: 3, status: 'PENDING' }, { id: 4, status: 'PENDING' }];
  const issues = [{ orderItemId: 3, status: 'WAITING_CUSTOMER' }];
  assert.equal(nextWeighItem(items, issues, 1), 4);
  assert.equal(nextWeighItem(items, issues, 4), 1);
  assert.equal(nextWeighItem([{ id: 1, status: 'PENDING' }], [], 1), null);
});
