import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { computed, effectScope, nextTick, ref, watch } from "vue";
import { useCartStore } from "../app/stores/cart.ts";
import { useCartActions } from "../app/composables/useCartActions.ts";

const product = {
  id: 1, name: "Apples", slug: "apples", price: 350000, priceQty: 1000,
  unit: "GRAM", min: 500, step: 100, portionQty: 500, images: [],
  category: { name: "Fruit", slug: "fruit" },
};
const logoSource = await readFile(new URL("../app/components/app/MarketLogo.vue", import.meta.url), "utf8");
const headerSource = await readFile(new URL("../app/components/app/Header.vue", import.meta.url), "utf8");
const basketLogic = await readFile(new URL("../app/composables/useBasketScene.ts", import.meta.url), "utf8");
const sceneSource = await readFile(new URL("../app/components/app/BasketScene.vue", import.meta.url), "utf8");
const appSource = await readFile(new URL("../app/app.vue", import.meta.url), "utf8");

function setup() {
  setActivePinia(createPinia());
  const cart = useCartStore();
  const actions = useCartActions();
  return { cart, actions };
}

function executable(source, stopAt) {
  let script = source.includes("<script setup")
    ? source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    : source;
  if (stopAt) script = script.split(stopAt)[0];
  const parsed = ts.createSourceFile("component.ts", script, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse())
    if (ts.isImportDeclaration(statement))
      script = script.slice(0, statement.getStart()) + script.slice(statement.end);
  return ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

function basket(t) {
  const scope = effectScope();
  t.after(() => scope.stop());
  const mount = new Function("useCartStore", "ref", "computed", "watch",
    executable(basketLogic).replace("export function useBasketScene", "function useBasketScene") +
    "\nreturn useBasketScene();");
  return scope.run(() => mount(useCartStore, ref, computed, watch));
}

test("guest basket is empty until restore; real additions restart the animation", async t => {
  const { cart, actions } = setup();
  const scene = basket(t);
  assert.equal(cart.restored, false);
  assert.match(headerSource, /<AppBasketScene v-if="cart.restored"/);
  cart.restore([]);
  await nextTick();
  assert.equal(scene.sceneState.value, "empty");
  assert.equal(await actions.add(product), true);
  await nextTick();
  assert.equal(scene.sceneState.value, "animate");
  assert.equal(scene.sceneKey.value, 1);
  assert.equal(await actions.add(product), true);
  await nextTick();
  assert.equal(cart.qty(1), 1000);
  assert.equal(scene.sceneKey.value, 2);
  assert.equal(await actions.add({ ...product, id: 2 }), true);
  await nextTick();
  assert.equal(scene.sceneKey.value, 3);
  assert.equal(await actions.remove(2), true);
  await nextTick();
  assert.equal(scene.sceneKey.value, 3);
  assert.equal(cart.count, 1);
  assert.equal(await actions.clear(), true);
  await nextTick();
  assert.equal(scene.sceneState.value, "empty");
  cart.restore([{ product, qty: 500 }]);
  await nextTick();
  assert.equal(scene.sceneState.value, "full");
  assert.equal(scene.sceneKey.value, 3);
});

test("server add animates only after the authoritative snapshot confirms an increase", async t => {
  const { cart, actions } = setup();
  let qty = 500;
  let revision = 1;
  let fail = false;
  const snapshot = () => ({
    revision: String(revision),
    items: qty ? [{ productId: 1, qty, product, status: "AVAILABLE", lineTotal: qty * 350 }] : [],
    products: qty ? [product] : [],
    subtotal: qty * 350, valid: true, error: null, token: String(revision),
  });
  cart.bindServer({
    get: async () => snapshot(),
    change: async ({ kind, qty: desired, revision: expected }) => {
      if (fail || expected !== String(revision)) throw { statusCode: 409 };
      if (kind === "add") qty += desired;
      if (kind === "set") qty = desired;
      if (kind === "clear") qty = 0;
      revision++;
      return snapshot();
    },
  });
  cart.beginServer(7);
  const scene = basket(t);
  cart.applyServer(snapshot(), 7);
  await nextTick();
  assert.equal(scene.sceneState.value, "full");
  assert.equal(scene.sceneKey.value, 0);
  assert.equal(await actions.add(product), true);
  await nextTick();
  assert.equal(scene.sceneKey.value, 1);
  assert.equal(cart.qty(1), 1000);
  fail = true;
  assert.equal(await actions.add(product), false);
  await nextTick();
  assert.equal(scene.sceneKey.value, 1);
  fail = false;
  assert.equal(await actions.put(product, 700), true);
  await nextTick();
  assert.equal(scene.sceneKey.value, 1);
  assert.equal(await actions.put(product, 1300), true);
  await nextTick();
  assert.equal(scene.sceneKey.value, 2);
  qty = 1500;
  revision++;
  assert.equal(await cart.refreshServer(), true);
  await nextTick();
  assert.equal(scene.sceneKey.value, 2);
  assert.equal(await actions.clear(), true);
  await nextTick();
  assert.equal(scene.sceneState.value, "empty");
  qty = 500;
  revision++;
  assert.equal(await cart.refreshServer(), true);
  await nextTick();
  assert.equal(scene.sceneState.value, "full");
  assert.equal(scene.sceneKey.value, 2);
});

test("favicon follows restored cart and optional badge is stopped with the root", async t => {
  const { cart } = setup();
  const heads = [];
  const mounted = [];
  const unmounted = [];
  const badges = [];
  const badgeNavigator = {
    setAppBadge: async count => { badges.push(count); },
    clearAppBadge: async () => { badges.push(0); },
  };
  const scope = effectScope();
  t.after(() => scope.stop());
  const mount = new Function("useAuthStore", "useCartStore", "useSiteSeo", "useHead",
    "computed", "watch", "onMounted", "onBeforeUnmount", "navigator",
    executable(appSource, "const { data: user }") + "\nreturn { faviconState };");
  const root = scope.run(() => mount(
    () => ({}), useCartStore, () => {}, value => heads.push(value),
    computed, watch, callback => mounted.push(callback),
    callback => unmounted.push(callback), badgeNavigator,
  ));
  const links = () => heads[0]().link;
  assert.equal(root.faviconState.value, "empty");
  assert.deepEqual(links().map(link => link.href), [16, 32, 48].map(size => "/favicons/cart-empty-" + size + ".png"));
  cart.restore([{ product, qty: 500 }]);
  assert.equal(root.faviconState.value, "full");
  assert.deepEqual(links().map(link => link.href), [16, 32, 48].map(size => "/favicons/cart-full-" + size + ".png"));
  mounted[0]();
  assert.deepEqual(badges, [1]);
  cart.clear();
  await nextTick();
  assert.equal(root.faviconState.value, "empty");
  assert.deepEqual(badges, [1, 0]);
  unmounted[0]();
  cart.add(product);
  await nextTick();
  assert.deepEqual(badges, [1, 0]);
});

test("scene has finite phases and reduced-motion immediately shows the final state", () => {
  assert.match(sceneSource, /basket-scene__drop--front/);
  assert.match(sceneSource, /basket-scene__drop--greens/);
  assert.match(sceneSource, /basket-scene__full/);
  assert.match(sceneSource, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(sceneSource, /\binfinite\b/);
  assert.match(logoSource, /market-logo__korzina/);
  assert.match(logoSource, /market-logo__full/);
  assert.doesNotMatch(logoSource, /market-logo__compact/);
  assert.doesNotMatch(logoSource, /AppBasketScene/);
  assert.match(headerSource, /<AppBasketScene/);
});

test("manifest keeps app identity and serves static full-basket icons and cart shortcut", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/site.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.deepEqual(manifest.shortcuts, [{ name: "Корзина", url: "/cart" }]);
  const root = new URL("../public/", import.meta.url);
  for (const entry of manifest.icons) {
    const data = await readFile(new URL("." + entry.src, root));
    assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const size = Number(entry.sizes.split("x")[0]);
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
  }
  assert.deepEqual(manifest.icons.filter(icon => icon.purpose === "maskable").map(icon => icon.sizes),
    ["192x192", "512x512"]);
  for (const state of ["empty", "full"]) {
    const cutout = await readFile(new URL("../public/img/logo/" + state + "-cutout.webp", import.meta.url));
    assert.equal(cutout.toString("ascii", 0, 4), "RIFF");
    assert.equal(cutout.toString("ascii", 8, 16), "WEBPVP8X");
    assert.ok((cutout[20] & 16) !== 0, "basket photo must have alpha for both themes");
  }
  const ico = await readFile(new URL("../public/favicon.ico", import.meta.url));
  assert.equal(ico.readUInt16LE(4), 3);
  const config = await readFile(new URL("../nuxt.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(config, /rel: "icon"/);
  for (const state of ["empty", "full"])
    for (const size of [16, 32, 48]) {
      const icon = await readFile(new URL("../public/favicons/cart-" + state + "-" + size + ".png", import.meta.url));
      assert.equal(icon.readUInt32BE(16), size);
      assert.equal(icon.readUInt32BE(20), size);
    }
});
