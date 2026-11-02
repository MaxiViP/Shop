import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, reactive, ref, watch } from 'vue';
import { formatAddress } from '../app/utils/address.ts';

const modal = await readFile(new URL('../app/components/address/Modal.vue', import.meta.url), 'utf8');
function compile(source) {
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import [^\r\n]*(?:\r?\n|$)/gm, '');
  return ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const address = { id: 7, label: 'Дом', city: 'Москва', street: 'Рыночная', house: '1', flat: '3' };
function fixture(t, saved, lineEnding) {
  const code = compile(modal.replace(/\r?\n/g, lineEnding));
  const requests = [], stops = [], open = ref(true);
  const context = { computed, ref, reactive,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    defineProps: () => ({ address: saved }), defineEmits: () => () => {}, defineModel: () => open,
    useApiClient: () => async (path, options) => requests.push({ path, ...options }),
    useToast: () => ({ add() {} }),
  };
  const result = new Function(...Object.keys(context), code + '\nfill(); return { form, save };')(...Object.values(context));
  t.after(() => stops.forEach(stop => stop()));
  return { ...result, requests, open };
}

for (const lineEnding of ['\n', '\r\n']) {
test(`a new address can omit building text or save its free form (${JSON.stringify(lineEnding)})`, async t => {
  for (const part of ['', ' к. 2 ', 'стр. 1']) {
    const f = fixture(t, undefined, lineEnding);
    Object.assign(f.form, address, { buildingPart: part });
    await f.save();
    assert.equal(f.requests[0].method, 'POST');
    assert.equal(f.requests[0].body.buildingPart, part.trim());
    assert.equal(f.open.value, false);
  }
});

test(`editing retains or clears the saved building part (${JSON.stringify(lineEnding)})`, async t => {
  const legacy = fixture(t, address, lineEnding);
  assert.equal(legacy.form.buildingPart, '');
  const f = fixture(t, { ...address, buildingPart: 'корпус 3' }, lineEnding);
  assert.equal(f.form.buildingPart, 'корпус 3');
  f.form.buildingPart = '';
  await f.save();
  assert.equal(f.requests[0].path, '/addresses/7');
  assert.equal(f.requests[0].method, 'PATCH');
  assert.equal(f.requests[0].body.buildingPart, '');
});
}

test('customer, staff and admin representations share a formatter that keeps old addresses readable', () => {
  assert.equal(formatAddress(address), 'Москва, Рыночная, д. 1, кв. 3');
  assert.equal(formatAddress({ ...address, buildingPart: 'стр. 1' }), 'Москва, Рыночная, д. 1, стр. 1, кв. 3');
  assert.equal(formatAddress({ ...address, buildingPart: 'корпус 3' }, false), 'Москва, Рыночная, д. 1, корпус 3');
  assert.match(modal, /label="Корпус \/ строение"/);
  assert.doesNotMatch(modal, /required[^>]*Корпус \/ строение/);
});
