import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

test('only short coarse-pointer landscape hides the header and compacts spacing, with a reserved portrait height', async () => {
  const [header, css] = await Promise.all([
    readFile(new URL('../app/components/app/Header.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/assets/css/main.css', import.meta.url), 'utf8'),
  ]);
  for (const condition of ['orientation: landscape', 'max-height: 500px', 'max-width: 1024px', 'pointer: coarse']) {
    assert.ok(mobileLandscapeQuery.includes(condition)); assert.ok(header.includes(condition)); assert.ok(css.includes(condition));
  }
  assert.match(header, /\.header-spacer\s*\{[^}]*height:.*header-height/);
  assert.match(header, /\.header--hidden\s*\{[^}]*translateY\(-100%\)/);
  assert.doesNotMatch(header, /translateY\(100%\)/);
  assert.match(header, /prefers-reduced-motion: reduce/);
  assert.match(css, /--page-x: max\(1rem, var\(--safe-left\), var\(--safe-right\)\)/);
  assert.match(header, /landscape\.value \|\| \(scrolled\.value && notice/);
  assert.match(header, /mobileHeaderHidden\.value && \(cart\.count > 0/);
  assert.match(header, /<Teleport to="#floating-cart-anchor" :disabled="!floatingCartVisible">/);
  assert.match(header, /:should-scale-background="false"/);
  assert.match(header, /:no-body-styles="true"/);
  assert.equal((header.match(/class="header__burger-line"/g) ?? []).length, 3);
});
