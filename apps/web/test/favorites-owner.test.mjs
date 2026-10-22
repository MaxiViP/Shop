import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref, computed, reactive, watch, effectScope } from 'vue';

async function fixture(t) {
  const source = await readFile(new URL('../app/stores/favorites.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const auth = reactive({ user: { id: 1 }, loggedIn: true }), pending = [];
  const modules = {
    vue: { ref, computed, watch }, pinia: { defineStore: (_name, setup) => setup },
    '~/stores/auth': { useAuthStore: () => auth },
  };
  const module = { exports: {} };
  new Function('require', 'exports', 'useApiClient', code)(
    id => { assert.ok(modules[id], id); return modules[id]; }, module.exports,
    () => (path) => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  );
  const scope = effectScope();
  t.after(() => scope.stop());
  const store = scope.run(() => module.exports.useFavoritesStore());
  return { auth, pending, store };
}

test('late saved-products responses cannot replace another account or a newer refresh', async (t) => {
  const { auth, pending, store } = await fixture(t);
  const first = store.load();
  auth.user = { id: 2 };
  pending.shift().resolve({ items: [{ id: 11 }] });
  await first;
  assert.deepEqual(store.serverItems.value, []);

  const older = store.load(true), newer = store.load(true);
  const finishOlder = pending.shift(), finishNewer = pending.shift();
  finishNewer.resolve({ items: [{ id: 22 }] });
  await newer;
  finishOlder.resolve({ items: [{ id: 23 }] });
  await older;
  assert.deepEqual(store.serverItems.value, [{ id: 22 }]);

  const logout = store.load(true);
  store.clearServer();
  pending.shift().resolve({ items: [{ id: 24 }] });
  await logout;
  assert.deepEqual(store.serverItems.value, []);
});

test('a failed toggle from an old account preserves the new account and its pending toggle', async (t) => {
  const { auth, pending, store } = await fixture(t);
  store.serverIds.value = [11];
  store.serverItems.value = [{ id: 11 }];
  const older = store.toggle({ id: 11 });
  const oldRequest = pending.shift();
  const rejected = assert.rejects(older, /old account/);

  auth.user = { id: 2 };
  assert.equal(store.pending(11), false);
  const load = store.load();
  pending.shift().resolve({ items: [{ id: 11 }, { id: 22 }] });
  await load;
  const newer = store.toggle({ id: 11 });
  const newRequest = pending.shift();
  oldRequest.reject(new Error('old account'));
  await rejected;
  assert.deepEqual(store.serverIds.value, [22]);
  assert.deepEqual(store.serverItems.value, [{ id: 22 }]);
  assert.equal(store.pending(11), true);
  newRequest.resolve({ ok: true });
  await newer;
  assert.equal(store.pending(11), false);
});

test('logging back into the same account does not accept a stale rollback', async (t) => {
  const { auth, pending, store } = await fixture(t);
  store.serverIds.value = [11];
  store.serverItems.value = [{ id: 11 }];
  const toggle = store.toggle({ id: 11 });
  const rejected = assert.rejects(toggle, /old session/);
  auth.user = null;
  auth.user = { id: 1 };
  pending.shift().reject(new Error('old session'));
  await rejected;
  assert.deepEqual(store.serverIds.value, []);
  assert.deepEqual(store.serverItems.value, []);
});

test('rolling back one product preserves another product saved concurrently', async (t) => {
  const { pending, store } = await fixture(t);
  const older = store.toggle({ id: 11 });
  const oldRequest = pending.shift();
  const rejected = assert.rejects(older, /failed/);
  const newer = store.toggle({ id: 22 });
  pending.shift().resolve({ ok: true });
  await newer;
  oldRequest.reject(new Error('failed'));
  await rejected;
  assert.deepEqual(store.serverIds.value, [22]);
  assert.deepEqual(store.serverItems.value, [{ id: 22 }]);
});

test('a failed toggle rolls back its own product while preserving a newer server refresh', async (t) => {
  const { pending, store } = await fixture(t);
  const toggle = store.toggle({ id: 11 });
  const oldRequest = pending.shift();
  const rejected = assert.rejects(toggle, /failed/);
  const load = store.load(true);
  pending.shift().resolve({ items: [{ id: 22 }] });
  await load;
  oldRequest.reject(new Error('failed'));
  await rejected;
  assert.deepEqual(store.serverIds.value, [22]);
});

test('a delayed server snapshot preserves a successful toggle and loads other saved products', async (t) => {
  const { pending, store } = await fixture(t);
  const load = store.load(true);
  const read = pending.shift();
  const toggle = store.toggle({ id: 11 });
  pending.shift().resolve({ ok: true });
  await toggle;
  read.resolve({ items: [{ id: 22 }] });
  await load;
  assert.deepEqual(store.serverIds.value, [11, 22]);
});

test('a read overlapping a pending toggle preserves the optimistic product until rollback', async (t) => {
  const { pending, store } = await fixture(t);
  store.serverIds.value = [11];
  store.serverItems.value = [{ id: 11 }];
  const toggle = store.toggle({ id: 11 });
  const write = pending.shift();
  const rejected = assert.rejects(toggle, /failed/);
  const load = store.load(true);
  pending.shift().resolve({ items: [{ id: 11 }, { id: 22 }] });
  await load;
  assert.deepEqual(store.serverIds.value, [22]);
  write.reject(new Error('failed'));
  await rejected;
  assert.deepEqual(store.serverIds.value, [22, 11]);
});

test('a failed read cannot prevent a failed toggle from rolling back', async (t) => {
  const { pending, store } = await fixture(t);
  const toggle = store.toggle({ id: 11 });
  const write = pending.shift();
  const rejectedWrite = assert.rejects(toggle, /write failed/);
  const load = store.load(true);
  const rejectedRead = assert.rejects(load, /read failed/);
  pending.shift().reject(new Error('read failed'));
  await rejectedRead;
  write.reject(new Error('write failed'));
  await rejectedWrite;
  assert.deepEqual(store.serverIds.value, []);
});

test('a previous account sync neither blocks nor clears the new account sync', async (t) => {
  const { auth, pending, store } = await fixture(t);
  store.restoreGuest([7]);
  const older = store.syncAfterLogin();
  const oldRequest = pending.shift();
  auth.user = { id: 2 };
  const newer = store.syncAfterLogin();
  const newRequest = pending.shift();
  assert.equal(newRequest.path, '/favorites/sync');
  oldRequest.resolve({ ok: true });
  await older;
  assert.deepEqual(store.guestIds.value, [7]);
  assert.equal(pending.length, 0);
  newRequest.resolve({ ok: true });
  await Promise.resolve();
  assert.equal(pending[0].path, '/favorites');
  pending.shift().resolve({ items: [{ id: 7 }] });
  await newer;
  assert.deepEqual(store.serverIds.value, [7]);
  assert.deepEqual(store.guestIds.value, []);
});
