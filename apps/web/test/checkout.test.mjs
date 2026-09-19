import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, ref, reactive, watch, nextTick } from "vue";
import { createPinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import { deliveryEligibility } from "../app/utils/shop-settings.ts";
import { pickupDate } from "../app/utils/pickup.ts";

const page = await readFile(new URL("../app/pages/cart.vue", import.meta.url), "utf8");
const script = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile("cart.ts", script, ts.ScriptTarget.Latest, true);
let executable = script;
for (const statement of [...parsed.statements].reverse()) {
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
}
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const product = { id: 1, name: "Fixture", slug: "fixture", unit: "GRAM", price: 10000,
  priceQty: 1000, min: 500, step: 100, portionQty: 500, images: [],
  category: { name: "Fruit", slug: "fruit" } };

// Execute the actual page setup with Vue refs and local API fixtures.
// No template mounting, component framework, browser, or real requests.
async function fixture(t, authenticated = false) {
  const cart = useCartStore(createPinia());
  const pending = ref(false);
  const quoteError = ref("");
  const settings = ref({ deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 0 });
  const settingsError = ref(null);
  const address = { id: 2, isDefault: true, label: "Home", city: "City", street: "Street",
    house: "10", flat: "2", entrance: "3", floor: "4", intercom: "5", comment: "Call" };
  const state = { token: "confirmed", refreshFail: false, requests: [], navigation: [],
    remembered: false, post: async () => ({ publicId: "created-order" }), addressOptions: null };
  const quote = () => ({ valid: true, token: state.token, subtotal: 5000, error: null,
    items: [{ productId: 1, product, qty: cart.qty(1), lineTotal: 5000, status: "AVAILABLE" }] });
  cart.restore([{ product, qty: 500 }]);
  cart.applyQuote(quote(), cart.key);
  const stops = [];
  t.after(() => stops.forEach(stop => stop()));
  const context = {
    computed, ref, reactive,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    useCartStore: () => cart,
    useAuthStore: () => ({ loggedIn: authenticated,
      user: authenticated ? { id: 1, name: "User", phone: "+79990000000" } : null }),
    useApi: async (path, options) => {
      if (path === "/shop/settings") return { data: settings, error: settingsError, refresh: async () => {} };
      assert.equal(path, "/addresses");
      state.addressOptions = options;
      return { data: ref(authenticated ? [address] : []) };
    },
    useCartQuote: () => ({
      ready: computed(() => cart.quoteReady && !pending.value), pending, error: quoteError,
      refresh: async () => {
        cart.invalidateQuote();
        pending.value = true;
        await Promise.resolve();
        pending.value = false;
        if (state.refreshFail) { quoteError.value = "Quote unavailable"; return false; }
        return cart.applyQuote(quote(), cart.key);
      },
    }),
    useApiClient: () => async (path, options) => {
      assert.equal(path, "/orders");
      state.requests.push(options);
      return state.post();
    },
    useCheckoutName: () => ({ name: ref(authenticated ? "User" : ""),
      rememberOnSuccess: () => () => { state.remembered = true; } }),
    useHeaderNotice: () => ({ show() {} }),
    useSeoMeta() {},
    navigateTo: async path => { state.navigation.push(path); },
    deliveryEligibility, pickupDate,
  };
  const setup = new AsyncFunction(...Object.keys(context),
    executable + "\nreturn { form, canSubmit, submit, error, selectAddress, selectedAddressId };");
  const result = await setup(...Object.values(context));
  Object.assign(result.form, { name: "Recipient", phone: "+79990000000" });
  if (!authenticated) Object.assign(result.form, { city: "City", street: "Street", house: "10", comment: "Call" });
  return { ...result, cart, pending, state, settings, settingsError, address };
}

test("direct /checkout middleware redirects to /cart without browser globals or a loop", async () => {
  const source = await readFile(new URL("../app/pages/checkout.vue", import.meta.url), "utf8");
  const setup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  let meta;
  const calls = [];
  new Function("definePageMeta", "navigateTo", setup)(
    value => { meta = value; },
    (path, options) => { calls.push({ path, options }); return path; },
  );
  assert.equal(meta.middleware({ path: "/checkout", query: {} }), "/cart");
  assert.deepEqual(calls, [{ path: "/cart", options: { replace: true } }]);
  assert.doesNotMatch(script, /navigateTo\(["']\/checkout|route\.query/);
});

test("empty, stale, pending and invalid quotes cannot submit even with displayed server amounts", async t => {
  const f = await fixture(t);
  assert.equal(f.canSubmit.value, true);
  f.cart.invalidateQuote();
  assert.equal(f.cart.displayTotal, 5000);
  assert.equal(f.canSubmit.value, false);
  await f.submit();
  f.cart.applyQuote({ valid: false, token: null, subtotal: null, error: null,
    items: [{ productId: 1, product: null, qty: 500, status: "UNAVAILABLE", lineTotal: null }] }, f.cart.key);
  assert.equal(f.canSubmit.value, false);
  await f.submit();
  f.pending.value = true;
  assert.equal(f.canSubmit.value, false);
  await f.submit();
  f.cart.clear();
  f.pending.value = false;
  assert.equal(f.canSubmit.value, false);
  await f.submit();
  assert.equal(f.state.requests.length, 0);
});

for (const authenticated of [false, true]) {
  test(`${authenticated ? "user" : "guest"} order keeps recipient/address/comment/token and clears only on success`, async t => {
    const f = await fixture(t, authenticated);
    assert.equal(f.state.addressOptions.immediate, authenticated);
    if (authenticated) assert.equal(f.selectedAddressId.value, f.address.id);
    let accept;
    f.state.post = () => new Promise(resolve => { accept = resolve; });
    const submission = f.submit();
    for (let turn = 0; turn < 20 && !accept; turn++) await nextTick();
    assert.equal(typeof accept, "function", "Submission reached the mocked POST");
    assert.equal(f.cart.count, 1);
    assert.equal(f.state.requests.length, 1);
    const request = f.state.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.body.quoteToken, "confirmed");
    assert.equal(request.body.type, "DELIVERY");
    assert.equal(request.body.customerName, "Recipient");
    assert.equal(request.body.customerPhone, "+79990000000");
    assert.equal(request.body.address.comment, "Call");
    assert.deepEqual(request.body.items, [{ productId: 1, qty: 500 }]);
    assert.equal(Object.hasOwn(request.body, "subtotal"), false);
    accept({ publicId: "created-order" });
    await submission;
    assert.equal(f.cart.count, 0);
    assert.equal(f.state.remembered, true);
    assert.deepEqual(f.state.navigation, ["/order/created-order"]);
  });
}

test("changed quote token or quote failure prevents POST and keeps cart", async t => {
  for (const failure of ["token", "quote"]) {
    const f = await fixture(t);
    if (failure === "token") f.state.token = "changed";
    else f.state.refreshFail = true;
    await f.submit();
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.cart.count, 1);
    if (failure === "token") assert.ok(f.error.value);
  }
});

test("CART_CHANGED server error keeps cart, refreshes quote and never automatically retries POST", async t => {
  const f = await fixture(t);
  f.state.post = async () => { throw { data: { message: "CART_CHANGED" } }; };
  await f.submit();
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.cart.count, 1);
  assert.equal(f.error.value, "CART_CHANGED");
  assert.equal(f.state.remembered, false);
  assert.deepEqual(f.state.navigation, []);
});

test("delivery minimum still blocks delivery and pickup sends no delivery address", async t => {
  const f = await fixture(t);
  f.settings.value = { deliveryEnabled: true, pickupEnabled: false, minDeliverySubtotal: 10000 };
  await nextTick();
  assert.equal(f.canSubmit.value, false);
  await f.submit();
  assert.equal(f.state.requests.length, 0);
  f.settings.value.pickupEnabled = true;
  await nextTick();
  assert.equal(f.form.type, "PICKUP");
  assert.equal(f.canSubmit.value, true);
  await f.submit();
  assert.equal(f.state.requests[0].body.type, "PICKUP");
  assert.equal(f.state.requests[0].body.address, undefined);
});
