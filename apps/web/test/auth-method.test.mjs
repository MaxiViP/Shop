import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { useLoginMethod, fullPhone } from '../app/composables/useLoginMethod.ts';

test('incomplete phone never requests a method', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const state = useLoginMethod(async () => { calls++; return { method: 'OTP' }; });
  for (const phone of ['', '+7', '+7 999 000-00-0', '8999000000', 'letters', '+799900000011']) {
    assert.equal(fullPhone(phone), false);
    state.change(phone); t.mock.timers.tick(500);
  }
  assert.equal(calls, 0); assert.equal(state.mode.value, 'PHONE');
});

for (const method of ['OTP', 'PASSWORD']) test(`${method} response selects the matching mode after debounce`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const state = useLoginMethod(async () => { calls++; return { method }; });
  state.change('+79990000001');
  assert.equal(state.mode.value, 'CHECKING_METHOD');
  t.mock.timers.tick(399); assert.equal(calls, 0);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(calls, 1); assert.equal(state.mode.value, method);
});

test('phone changes clear previous mode and ignore an old response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const state = useLoginMethod(() => new Promise(done => { resolve = done; }));
  state.change('+79990000001'); t.mock.timers.tick(400);
  state.change('+7');
  assert.equal(state.mode.value, 'PHONE');
  resolve({ method: 'PASSWORD' }); await setImmediate();
  assert.equal(state.mode.value, 'PHONE');
});

test('typing restarts debounce; closing cancels a pending lookup', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const state = useLoginMethod(async () => { calls++; return { method: 'OTP' }; });
  state.change('+79990000001'); t.mock.timers.tick(300);
  state.change('+79990000002'); t.mock.timers.tick(300);
  assert.equal(calls, 0);
  state.reset(); t.mock.timers.tick(500); assert.equal(calls, 0);
});

test('lookup failure allows retry without displaying an incorrect mode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const state = useLoginMethod(async () => { if (!calls++) throw new Error('unavailable'); return { method: 'PASSWORD' }; });
  state.change('+79990000001'); t.mock.timers.tick(400); await setImmediate();
  assert.equal(state.mode.value, 'PHONE'); assert.ok(state.error.value);
  state.change('+79990000001', 0); t.mock.timers.tick(0); await setImmediate();
  assert.equal(state.mode.value, 'PASSWORD'); assert.equal(state.error.value, null);
  state.change('+79990000002'); assert.equal(state.mode.value, 'CHECKING_METHOD');
  state.reset();
});
