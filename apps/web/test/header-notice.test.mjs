import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHeaderProgress } from "../app/utils/header-progress.ts";
import {
  createHeaderNotice,
  NOTICE_DURATION,
} from "../app/utils/header-notice.ts";

function progressFixture() {
  const callbacks = new Map();
  let id = 0;
  const progress = createHeaderProgress(
    (callback) => {
      callbacks.set(++id, callback);
      return id;
    },
    (key) => callbacks.delete(key),
  );
  function frame() {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  }
  return { progress, frame, callbacks };
}

test("progress starts false, waits two frames, then runs; each notice restarts false → true", () => {
  const { progress, frame } = progressFixture();
  assert.equal(progress.running.value, false);
  progress.start();
  assert.equal(progress.running.value, false);
  frame();
  assert.equal(progress.running.value, false);
  frame();
  assert.equal(progress.running.value, true);
  progress.start();
  assert.equal(progress.running.value, false);
  frame();
  frame();
  assert.equal(progress.running.value, true);
});

test("rapid progress restart and cleanup cancel old frame callbacks", () => {
  const { progress, frame, callbacks } = progressFixture();
  progress.start();
  frame();
  progress.start();
  progress.start();
  assert.equal(callbacks.size, 1);
  frame();
  assert.equal(progress.running.value, false);
  progress.reset();
  frame();
  assert.equal(progress.running.value, false);
  assert.equal(callbacks.size, 0);
});

test("timer has a scoped exception to global reduced-motion reset, not a full-width fallback", async () => {
  const css = await readFile(
    new URL("../app/assets/css/main.css", import.meta.url),
    "utf8",
  );
  const component = await readFile(
    new URL("../app/components/app/HeaderNotice.vue", import.meta.url),
    "utf8",
  );
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(
    component,
    /\.header-notice__progress-fill\s*\{[^}]*width:\s*var\(--notice-start\)/,
  );
  const reduced = component.slice(
    component.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(
    reduced,
    /\.header-notice__progress-fill--run\s*\{[^}]*transition-duration:\s*var\(--notice-remaining\)\s*!important/,
  );
  assert.doesNotMatch(reduced, /width:\s*100%|animation:\s*none/);
  assert.match(component, /:key="notice.id"/);
  assert.match(component, /flush: "pre"/);
  assert.equal(NOTICE_DURATION, 2200);
  assert.match(component, /'--notice-start': startWidth/);
  assert.match(component, /'--notice-remaining': remaining/);
  assert.match(component, /transition: width var\(--notice-remaining\) linear/);
});

test("cart notice carries target/text, no duplicate count state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = createHeaderNotice();
  state.show({ target: "cart", text: "Добавлено в корзину" });
  assert.deepEqual({ ...state.current.value, shownAt: 0 }, {
    target: "cart",
    text: "Добавлено в корзину",
    id: 1,
    shownAt: 0,
  });
  assert.ok(state.current.value.shownAt <= Date.now());
  state.clear();
});

test("repeated action replaces notice and restarts the full lifetime", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = createHeaderNotice();
  state.show({ target: "cart", text: "Added" });
  t.mock.timers.tick(1500);
  state.show({ target: "cart", text: "Quantity updated" });
  assert.equal(state.current.value.id, 2);
  assert.equal(state.current.value.text, "Quantity updated");
  t.mock.timers.tick(NOTICE_DURATION - 1);
  assert.equal(state.current.value.target, "cart");
  t.mock.timers.tick(1);
  assert.equal(state.current.value, null);
});

test("favorites targets its own action, replacing rather than stacking", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = createHeaderNotice();
  state.show({ target: "cart", text: "Added" });
  state.show({ target: "favorites", text: "Добавлено в избранное" });
  assert.equal(state.current.value.target, "favorites");
  state.show({ target: "favorites", text: "Удалено из избранного" });
  assert.equal(state.current.value.text, "Удалено из избранного");
  state.clear();
});

test("auto dismiss and cleanup cancel pending state without affecting another instance", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = createHeaderNotice();
  const other = createHeaderNotice();
  state.show({ target: "cart", text: "Added" });
  assert.equal(other.current.value, null);
  t.mock.timers.tick(NOTICE_DURATION);
  assert.equal(state.current.value, null);
  state.show({ target: "favorites", text: "Added" });
  state.clear();
  state.clear();
  t.mock.timers.tick(NOTICE_DURATION * 2);
  assert.equal(state.current.value, null);
  state.show({ target: "cart", text: "Next" });
  t.mock.timers.tick(NOTICE_DURATION - 1);
  assert.equal(state.current.value.text, "Next");
  state.clear();
});

test("one cart notice moves with the one cart control without resetting its progress", async () => {
  const header = await readFile(
    new URL("../app/components/app/Header.vue", import.meta.url), "utf8",
  );
  const panel = await readFile(
    new URL("../app/components/app/HeaderNotice.vue", import.meta.url), "utf8",
  );
  assert.match(header, /<Teleport to="#floating-cart-anchor" :disabled="!floatingCartVisible">/);
  assert.match(header, /<div\s+id="floating-cart-anchor"[\s\S]*floating-cart-anchor--visible/);
  assert.equal((header.match(/<AppHeaderNotice target="cart"/g) ?? []).length, 1);
  assert.equal((header.match(/<AppBasketScene /g) ?? []).length, 1);
  assert.match(header, /<AppHeaderNotice target="cart" :floating="floatingCartVisible" \/>/);
  assert.doesNotMatch(header, /<AppHeaderNotice v-if=/);
  assert.match(header, /mobileHeaderHidden\.value && \(cart\.count > 0 \|\| notice\.current\?\.target === "cart"\)/);
  assert.match(header, /notice\.current\?\.target !== "favorites"/);
  assert.equal((header.match(/role="status"/g) ?? []).length, 1);
  assert.equal((panel.match(/role="status"/g) ?? []).length, 0);
  assert.match(header, /<AppHeaderNotice target="favorites" \/>/);
  assert.match(panel, /\.header-notice--floating\s*\{[^}]*safe-area-inset-left[^}]*safe-area-inset-right/);
  assert.match(header, /\.floating-cart-anchor\s*\{[^}]*position:\s*fixed;[^}]*safe-area-inset-top[^}]*safe-area-inset-right/);
  assert.match(panel, /Date\.now\(\) - active\.shownAt/);
});
