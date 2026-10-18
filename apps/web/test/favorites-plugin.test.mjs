import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('saved favorites are restored only after asynchronous hydration is ready', async () => {
  const source = await readFile(new URL('../app/plugins/favorites.client.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let ready, restored, subscribed = false, watched = false;
  const saved = '[1,2,3]';
  const favorites = {
    restoreGuest(value) { restored = value; },
    $subscribe() { subscribed = true; },
    clearServer() {},
  };
  const modules = {
    vue: { watch(_source, callback, options) { watched = true; if (options.immediate) callback(null); } },
    '#app': {
      defineNuxtPlugin: setup => setup,
      onNuxtReady(callback) { ready = callback; },
    },
    '~/stores/auth': { useAuthStore: () => ({ user: null }) },
    '~/stores/favorites': { useFavoritesStore: () => favorites },
  };
  const module = { exports: {} };
  new Function('require', 'exports', 'useToast', 'localStorage', code)(
    id => { assert.ok(modules[id], id); return modules[id]; }, module.exports, () => ({}),
    { getItem: () => saved },
  );
  // Nuxt app:mounted may precede async setup/Suspense hydration.
  module.exports.default({ isHydrating: true });
  assert.equal(typeof ready, 'function');
  assert.equal(restored, undefined);
  assert.equal(subscribed, false);
  assert.equal(watched, false);
  ready();
  assert.deepEqual(restored, [1, 2, 3]);
  assert.equal(subscribed, true);
  assert.equal(watched, true);
});
