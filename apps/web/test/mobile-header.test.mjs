import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, effectScope, reactive, ref, watch } from 'vue';
import { createHeaderScroll, mobileLandscapeQuery } from '../app/utils/header-scroll.ts';

test('down scroll hides, a deliberate up scroll returns even far below the page top', () => {
  const scroll = createHeaderScroll();
  assert.equal(scroll.reset(0), false);
  for (const y of [24, 40, 65]) assert.equal(scroll.sample(y), false);
  assert.equal(scroll.sample(100), true);
  assert.equal(scroll.sample(240), true);
  assert.equal(scroll.sample(220), false);
  assert.equal(scroll.sample(250), true);
});

test('finger jitter and overscroll keep the state stable and route restoration uses the current offset', () => {
  const scroll = createHeaderScroll();
  assert.equal(scroll.reset(200), true);
  for (const y of [198, 199, 196, 200, 201, 198]) assert.equal(scroll.sample(y), true);
  assert.equal(scroll.sample(180), false);
  for (const y of [182, 179, 181, 178]) assert.equal(scroll.sample(y), false);
  assert.equal(scroll.sample(24), false);
  assert.equal(scroll.sample(-10), false);
  assert.equal(scroll.reset(300), true);
  assert.equal(scroll.reset(0), false);
});

const header = await readFile(new URL('../app/components/app/Header.vue', import.meta.url), 'utf8');
const script = header.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('header.ts', script, ts.ScriptTarget.Latest, true);
let executable = script;
for (const statement of [...parsed.statements].reverse())
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture(t, viewport) {
  let size = { ...viewport }, nextFrame = 0;
  const frames = new Map(), events = new Map(), media = new Map(), mounted = [], unmounted = [];
  const notice = reactive({ current: null, clear() { this.current = null; } });
  const cart = reactive({ count: 1, displayTotal: 12500000, quoteReady: true });
  const match = query => query === '(width < 768px)'
    ? size.width < 768
    : size.width > size.height && size.pointer === 'coarse';
  const window = {
    scrollY: 0,
    matchMedia: query => {
      assert.ok(query === '(width < 768px)' || query === mobileLandscapeQuery);
      const listeners = new Set();
      const result = { get matches() { return match(query); },
        addEventListener: (name, callback) => listeners.add(callback),
        removeEventListener: (name, callback) => listeners.delete(callback), listeners };
      media.set(query, result);
      return result;
    },
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: name => events.delete(name),
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const context = { ref, computed, watch, window,
    useRoute: () => reactive({ path: '/catalog', fullPath: '/catalog' }),
    useAuthStore: () => reactive({ user: null }), useCartStore: () => cart,
    useFavoritesStore: () => ({ count: 0 }), useOrdersAction: () => ({}),
    useBasketScene: () => ({ sceneKey: ref(0), sceneState: ref('full') }),
    useHeaderNotice: () => ({ get current() { return notice.current; }, clear: () => notice.clear() }),
    headerAccount: () => ({}), customerBotUrl: () => null,
    useRuntimeConfig: () => ({ public: { telegramCustomerBotUrl: '' } }), money: value => String(value),
    createHeaderScroll, mobileLandscapeQuery,
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback),
  };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(context), executable +
    '\nreturn { mobileHeaderHidden, floatingCartVisible, mobileOpen, loginOpen };')(...Object.values(context)));
  mounted.forEach(callback => callback());
  t.after(() => { unmounted.forEach(callback => callback()); scope.stop(); });
  return { ...state, cart, notice,
    scroll(y) {
      window.scrollY = y; events.get('scroll')?.();
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());
    },
    resize(viewport) {
      const previous = [...media].map(([query, value]) => [query, value.matches]);
      size = { ...viewport };
      for (const [query, before] of previous) {
        const value = media.get(query);
        if (before !== value.matches) value.listeners.forEach(callback => callback());
      }
    },
  };
}

test('portrait, landscape and unfolded touch widths use the same down/up scroll and one floating cart', t => {
  for (const [width, height] of [[390, 844], [667, 375], [1024, 768], [1368, 912], [1800, 900]]) {
    const f = fixture(t, { width, height, pointer: 'coarse' });
    assert.equal(f.mobileHeaderHidden.value, false, 'visible at ' + width + '×' + height);
    assert.equal(f.floatingCartVisible.value, false);
    f.scroll(120);
    assert.equal(f.mobileHeaderHidden.value, true);
    assert.equal(f.floatingCartVisible.value, true);
    f.scroll(102);
    assert.equal(f.mobileHeaderHidden.value, false);
    assert.equal(f.floatingCartVisible.value, false);
  }
});

test('a wide fine-pointer desktop stays visible, including a short landscape window', t => {
  for (const height of [400, 900]) {
    const f = fixture(t, { width: 1280, height, pointer: 'fine' });
    f.scroll(200);
    assert.equal(f.mobileHeaderHidden.value, false);
    assert.equal(f.floatingCartVisible.value, false);
  }
});

test('landscape retains drawer/login/notice exceptions and the existing empty-cart behavior', t => {
  const f = fixture(t, { width: 1024, height: 768, pointer: 'coarse' });
  f.scroll(180);
  f.mobileOpen.value = true;
  assert.equal(f.mobileHeaderHidden.value, false); assert.equal(f.floatingCartVisible.value, false);
  f.mobileOpen.value = false; f.loginOpen.value = true;
  assert.equal(f.mobileHeaderHidden.value, false);
  f.loginOpen.value = false; f.notice.current = { target: 'favorites' };
  assert.equal(f.mobileHeaderHidden.value, false);
  f.notice.current = null; f.cart.count = 0;
  assert.equal(f.mobileHeaderHidden.value, true); assert.equal(f.floatingCartVisible.value, false);
  f.notice.current = { target: 'cart' };
  assert.equal(f.floatingCartVisible.value, true);
});

test('orientation and input changes do not force-hide a header at the page top', t => {
  const f = fixture(t, { width: 390, height: 844, pointer: 'coarse' });
  f.resize({ width: 1024, height: 768, pointer: 'coarse' });
  assert.equal(f.mobileHeaderHidden.value, false);
  f.scroll(120);
  assert.equal(f.floatingCartVisible.value, true);
  f.resize({ width: 1280, height: 400, pointer: 'fine' });
  assert.equal(f.mobileHeaderHidden.value, false); assert.equal(f.floatingCartVisible.value, false);
});

test('landscape reserves header height and safe-area with no forced transform or width cutoff', async () => {
  const css = await readFile(new URL('../app/assets/css/main.css', import.meta.url), 'utf8');
  assert.equal(mobileLandscapeQuery, '(orientation: landscape) and (pointer: coarse)');
  assert.ok(header.includes(mobileLandscapeQuery)); assert.ok(css.includes(mobileLandscapeQuery));
  assert.match(header, /\.header-spacer\s*\{[^}]*height:.*header-height.*safe-area-inset-top.*1px/);
  assert.match(header, /\.header--hidden\s*\{[^}]*translateY\(-100%\)/);
  assert.doesNotMatch(header, /\.header\s*\{[^}]*translateY|landscape\.value|translateY\(100%\)/);
  assert.doesNotMatch(css, /--header-height: 0/);
  assert.match(header, /prefers-reduced-motion: reduce/);
  assert.match(css, /--page-x: max\(clamp\([^;]*var\(--safe-left\)[^;]*var\(--safe-right\)/);
  assert.match(header, /narrow\.value && scrolled\.value && !mobileOpen\.value && !loginOpen\.value/);
  assert.match(header, /mobileHeaderHidden\.value && \(cart\.count > 0/);
  assert.match(header, /<Teleport to="#floating-cart-anchor" :disabled="!floatingCartVisible">/);
  assert.match(header, /:should-scale-background="false"/);
  assert.match(header, /:no-body-styles="true"/);
  assert.equal((header.match(/class="header__burger-line"/g) ?? []).length, 3);
});
