import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ref } from 'vue';
import ts from 'typescript';
import { isStaff, isPointOwner } from '../app/utils/permissions.ts';

const source = await readFile(new URL('../app/composables/useMobileGrid.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
function fixture(cookieValue) {
  const cookie = ref(cookieValue), state = new Map();
  return { cookie, grid: () => new Function('useCookie', 'useState', code + '; return useMobileGrid();')(
    () => cookie, (key, create) => { if (!state.has(key)) state.set(key, ref(create())); return state.get(key); },
  ) };
}
test('mobile grid restores only 2/3/4 columns and shares the choice between catalog groups', () => {
  for (const value of [undefined, 0, 1, 5, '4', null]) assert.equal(fixture(value).grid().columns.value, 2);
  const { grid, cookie } = fixture(3);
  const first = grid(), second = grid();
  assert.equal(first.columns.value, 3);
  first.select(4);
  assert.equal(second.columns.value, 4);
  assert.equal(cookie.value, 4);
  assert.equal(fixture(cookie.value).grid().columns.value, 4);
});
test('ownership adds fulfillment capability independently of the seller role', () => {
  assert.equal(isStaff({ role: 'USER' }), false);
  assert.equal(isStaff({ role: 'USER', ownedPoints: [{ marketPointId: 10 }] }), true);
  assert.equal(isPointOwner({ role: 'SELLER', ownedPoints: [{ marketPointId: 10 }] }), true);
  assert.equal(isStaff({ role: 'SELLER', ownedPoints: [] }), true);
  assert.equal(isStaff(null), false);
});
