import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { money } from "../app/utils/money.ts";

const header = await readFile(new URL("../app/components/app/Header.vue", import.meta.url), "utf8");
const brand = await readFile(new URL("../app/components/app/MarketLogo.vue", import.meta.url), "utf8");
const orders = await readFile(new URL("../app/components/app/OrdersAction.vue", import.meta.url), "utf8");
const beforeDrawer = header.slice(0, header.indexOf("<UDrawer"));

test("brand, navigation and actions follow the requested order", () => {
  assert.ok(beforeDrawer.indexOf('class="header__brand"') < beforeDrawer.indexOf('class="header__nav"'));
  assert.ok(beforeDrawer.indexOf('class="header__nav"') < beforeDrawer.indexOf('class="header__actions"'));
  const actions = beforeDrawer.slice(beforeDrawer.indexOf('class="header__actions"'));
  const parts = ['class="header__profile"', '<AppOrdersAction', 'header__action--favorites', 'header__action--cart'];
  const positions = parts.map(part => actions.indexOf(part));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(brand, /Korzina<\/span><span[^>]*>Market/);
  assert.match(brand, /market-logo__full/);
  assert.match(brand, /font-size: clamp\(/);
  assert.doesNotMatch(brand, /market-logo__compact|>KM</);
  assert.doesNotMatch(brand, /AppBasketScene|useCartStore/);
});

test("icon navigation keeps labels, active routes, theme and staff actions", () => {
  for (const name of ["layout-grid", "truck", "send"])
    assert.match(beforeDrawer, new RegExp('i-lucide-' + name));
  assert.match(beforeDrawer, /:aria-current="catalogActive \? 'page' : undefined"/);
  assert.match(beforeDrawer, /:aria-current="deliveryActive \? 'page' : undefined"/);
  assert.match(header, /route\.path\.startsWith\("\/product\/"\)/);
  assert.equal((header.match(/<AppThemeControl/g) ?? []).length, 2);
  assert.match(header, /v-if="account\.adminTo"/);
  assert.match(header, /staff\/orders/);
  assert.match(orders, /action\.newOrdersCount/);
  assert.match(orders, /action\.unreadMessagesCount/);
  assert.match(header, /<AppHeaderNotice target="favorites"/);
  assert.match(header, /header__favorite-icon/);
  assert.doesNotMatch(header, /useColorMode\(/);
});

test("one animated cart link keeps its quote status while moving between anchors", () => {
  assert.ok(header.indexOf('id="floating-cart-anchor"') < header.indexOf('<Teleport to="#floating-cart-anchor"'));
  assert.equal((beforeDrawer.match(/<AppBasketScene /g) ?? []).length, 1);
  assert.equal((beforeDrawer.match(/<AppHeaderNotice target="cart"/g) ?? []).length, 1);
  assert.match(beforeDrawer, /<Teleport to="#floating-cart-anchor" :disabled="!floatingCartVisible">/);
  assert.match(beforeDrawer, /<NuxtLink\s+to="\/cart"\s+class="cart-control"/);
  assert.match(beforeDrawer, /:key="sceneKey" :state="sceneState"/);
  assert.match(header, /useBasketScene\(\)/);
  assert.match(beforeDrawer, /cart\.displayTotal !== null/);
  assert.ok(beforeDrawer.includes(String.fromCodePoint(0x2248) + " "));
  assert.ok(beforeDrawer.includes(String.fromCodePoint(0x2026)));
  assert.match(beforeDrawer, /:aria-busy="cart\.count > 0 && !cart\.quoteReady/);
  assert.ok(beforeDrawer.indexOf('class="cart-control__amount"') < beforeDrawer.indexOf('class="cart-control__scene"'));
  assert.match(header, /\.cart-control\s*\{[^}]*min-width:\s*var\(--touch-target\);[^}]*flex:\s*none;[^}]*flex-direction:\s*row/);
  assert.doesNotMatch(header, /\.cart-control[^{]*\{[^}]*flex-direction:\s*column/);
  assert.match(header, /\.cart-control__amount\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--ui-success\)/);
  assert.match(header, /\.cart-control__amount\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(header, /\.cart-control__amount-value\s*\{[^}]*animation:\s*cart-control-refresh 180ms/);
  assert.match(header, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.cart-control__amount-value\s*\{[^}]*animation:\s*none/);
});

test("cart amount keeps large formatted totals on one horizontal line", () => {
  const ruble = String.fromCodePoint(0x20bd);
  for (const [value, label] of [[99, "99"], [1250, "1 250"], [12500, "12 500"], [125000, "125 000"]])
    assert.equal(money(value * 100).replace(/\s/g, " "), `${label} ${ruble}`);
  assert.match(beforeDrawer, /v-if="cart\.count"\s+class="cart-control__amount"/);
  assert.match(header, /\.cart-control__scene\s*\{[^}]*width:\s*2\.5rem;[^}]*height:\s*2\.5rem/);
  assert.match(header, /\.cart-control__amount\s*\{[^}]*font-variant-numeric:\s*tabular-nums;[^}]*white-space:\s*nowrap/);
});

test("empty and filled cart keep the same right edge without a reserved amount slot", () => {
  const actionsCss = header.match(/\.header__actions\s*\{([^}]*)\}/)?.[1];
  const amountCss = header.match(/\.cart-control__amount\s*\{([^}]*)\}/)?.[1];
  assert.ok(actionsCss);
  assert.ok(amountCss);
  assert.match(actionsCss, /margin-left:\s*auto/);
  assert.match(actionsCss, /gap:\s*0\.25rem/);
  assert.doesNotMatch(actionsCss, /space-between|width:/);
  assert.match(amountCss, /flex:\s*none/);
  for (const match of header.matchAll(/(?:\.header__action--floating )?\.cart-control\s*\{([^}]*)\}/g))
    assert.doesNotMatch(match[1], /^\s*width:/m);
  assert.match(header, /\.cart-control__scene\s*\{[^}]*flex:\s*none/);
  assert.match(header, /\.header__actions :deep\(a\)[^}]*min-width:\s*var\(--touch-target\)/);
});

test("mobile layout, menu controls and visible-cart logic retain safe boundaries", () => {
  assert.match(header, /@media \(min-width: 24rem\)/);
  assert.match(header, /@media \(min-width: 28rem\)/);
  assert.match(header, /@media \(min-width: 48rem\)/);
  assert.match(header, /\.header__profile,\s*\.header__orders,\s*\.header__favorites[^}]*display:\s*none/);
  assert.match(header, /@media \(width < 768px\)/);
  assert.match(header, /:aria-expanded="mobileOpen"/);
  assert.match(header, /aria-controls="mobile-menu"/);
  assert.equal((beforeDrawer.match(/class="header__burger-line"/g) ?? []).length, 3);
  assert.match(header, /@keydown\.esc="mobileOpen = false"/);
  assert.match(header, /:should-scale-background="false"/);
  assert.match(header, /:no-body-styles="true"/);
  assert.match(header, /notice\.current\?\.target !== "favorites"/);
  assert.match(header, /mobileHeaderHidden\.value && \(cart\.count > 0 \|\| notice\.current\?\.target === "cart"\)/);
  assert.match(header, /safe-area-inset-top/);
  assert.match(header, /safe-area-inset-right/);
  assert.match(header, /prefers-reduced-motion: reduce/);
  assert.ok(header.indexOf("<template>") < header.indexOf('<script setup lang="ts">'));
  assert.ok(header.indexOf('<script setup lang="ts">') < header.indexOf("<style scoped>"));
});
