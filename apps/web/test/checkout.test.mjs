import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, ref, shallowRef, reactive, watch, nextTick } from "vue";
import { createPinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import { deliveryEligibility } from "../app/utils/shop-settings.ts";
import { pickupDate } from "../app/utils/pickup.ts";
import { recipientDefaults, recipientDraft } from "../app/utils/checkout-recipient.ts";
import { checkoutErrors, checkoutFieldOrder, validOrderPhone } from "../app/utils/checkout-validation.ts";

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
async function fixture(t, authenticated = false, preserveDefault = false) {
  const cart = useCartStore(createPinia());
  const pending = ref(false);
  const quoteError = ref("");
  const settings = ref({ deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 0 });
  const settingsError = ref(null);
  const queueOffer = ref({ queueLength: 0, position: 1, wait: { min: 0, max: 10 },
    showScheduledOffer: false, peakModeActive: false, slots: [] });
  const address = { id: 2, isDefault: true, label: "Home", city: "City", street: "Street",
    house: "10", flat: "2", entrance: "3", floor: "4", intercom: "5", comment: "Call" };
  const user = authenticated
    ? { id: 1, role: "USER", name: "User", phone: "+79990000000", telegram: null }
    : null;
  const state = { token: "confirmed", refreshFail: false, requests: [], sessionCalls: 0, navigation: [],
    remembered: false, post: async () => authenticated
      ? { order: { publicId: "created-order" }, cart: emptySnapshot() }
      : { publicId: "created-order" }, addressOptions: null };
  const quote = () => ({ valid: true, token: state.token, subtotal: 5000, error: null,
    items: [{ productId: 1, product, qty: cart.qty(1), lineTotal: 5000, status: "AVAILABLE" }] });
  cart.restore([{ product, qty: 500 }]);
  cart.applyQuote(quote(), cart.key);
  const emptySnapshot = () => ({ revision: "00000000-0000-4000-8000-000000000002",
    valid: true, token: null, subtotal: 0, error: null, items: [], products: [] });
  if (authenticated) {
    const initialQuote = quote();
    cart.beginServer(user.id);
    cart.applyServer({ ...initialQuote, revision: "00000000-0000-4000-8000-000000000001",
      products: [product] }, user.id);
  }
  const stops = [];
  t.after(() => stops.forEach(stop => stop()));
  const context = {
    computed, ref, shallowRef, reactive, nextTick,
    onBeforeUnmount: callback => t.after(callback),
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    useCartStore: () => cart,
    useCartActions: () => ({
      put: async (p, qty) => cart.put(p, qty),
      clear: async () => { cart.clear(); return true; },
    }),
    useAuthStore: () => ({ loggedIn: authenticated, user }),
    useApi: async (path, options) => {
      if (path === "/shop/settings") return { data: settings, error: settingsError, refresh: async () => {} };
      if (path === "/orders/queue/offer") return { data: queueOffer, refresh: async () => {} };
      if (path === "/order-phones") {
        state.phoneOptions = options;
        return { data: ref(authenticated
          ? { phones: [{ id: null, phone: user.phone, source: "ACCOUNT" },
              { id: 7, phone: "+79990000009", source: "MANUAL" }],
            primaryPhone: "+79990000009" }
          : null), refresh: async () => {} };
      }
      assert.equal(path, "/addresses");
      state.addressOptions = options;
      return { data: ref(authenticated ? [address] : []), refresh: async () => {} };
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
      if (path === "/orders/checkout-session") {
        assert.equal(authenticated, false);
        assert.equal(options.method, "POST");
        state.sessionCalls++;
        return { ready: true };
      }
      assert.equal(path, authenticated ? "/cart/checkout" : "/orders");
      state.requests.push({ path, ...options });
      return state.post();
    },
    useCheckoutName: () => ({ name: ref(authenticated ? "User" : ""),
      rememberOnSuccess: () => () => { state.remembered = true; } }),
    useHeaderNotice: () => ({ show() {} }),
    useSeoMeta() {},
    navigateTo: async path => { state.navigation.push(path); },
    deliveryEligibility, pickupDate, recipientDefaults, recipientDraft,
    checkoutErrors, checkoutFieldOrder,
  };
  const setup = new AsyncFunction(...Object.keys(context),
    executable + "\nreturn { form, recipientMode, recipient, self, other, canSubmit, submit, error, errors, shakeFields, selectAddress, selectedAddressId, selectedPhone, choosePhone, onPhoneInput, availablePhones, phoneData };");
  const result = await setup(...Object.values(context));
  Object.assign(result.recipient.value, { name: "Recipient", ...(preserveDefault ? {} : { phone: "+79990000000" }) });
  if (!authenticated) Object.assign(result.recipient.value, { city: "City", street: "Street", house: "10", comment: "Call" });
  return { ...result, cart, pending, state, settings, settingsError, queueOffer, address, user };
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
    assert.match(request.body.checkoutRequestId, /^[0-9a-f-]{36}$/i);
    assert.equal(request.body.address.comment, "Call");
    if (authenticated) {
      assert.equal(request.path, "/cart/checkout");
      assert.equal(f.state.sessionCalls, 0);
      assert.equal(request.body.revision, "00000000-0000-4000-8000-000000000001");
      assert.equal(Object.hasOwn(request.body, "items"), false);
    } else {
      assert.equal(request.path, "/orders");
      assert.equal(f.state.sessionCalls, 1);
      assert.deepEqual(request.body.items, [{ productId: 1, qty: 500 }]);
    }
    assert.equal(Object.hasOwn(request.body, "subtotal"), false);
    accept(authenticated
      ? { order: { publicId: "created-order" }, cart: { revision: "00000000-0000-4000-8000-000000000002",
          valid: true, token: null, subtotal: 0, error: null, items: [], products: [] } }
      : { publicId: "created-order" });
    await submission;
    assert.equal(f.cart.count, 0);
    assert.equal(f.state.remembered, true);
    assert.deepEqual(f.state.navigation, ["/order/created-order"]);
  });
}

test("scheduled choice appears only with a queue offer and sends an authoritative slot request", async t => {
  const f = await fixture(t);
  assert.match(page, /v-if="queueOffer\?\.showScheduledOffer"/);
  assert.equal(f.queueOffer.value.showScheduledOffer, false);
  const slot = "2099-01-01T12:00:00.000Z";
  f.queueOffer.value = { queueLength: 4, position: 5, wait: { min: 30, max: 45 },
    showScheduledOffer: true, peakModeActive: false, slots: [{ at: slot, reserved: 0, capacity: 1 }] };
  await nextTick();
  f.form.pickupTiming = "scheduled";
  f.form.pickupAt = slot;
  await f.submit();
  const body = f.state.requests[0].body;
  assert.equal(body.fulfillmentMode, "SCHEDULED");
  assert.equal(body.scheduledFor, slot);
  assert.equal(Object.hasOwn(body, "queuePosition"), false);
  assert.equal(Object.hasOwn(body, "wait"), false);
});

test("a slot that fills during checkout is removed from the selection", async t => {
  const f = await fixture(t);
  assert.match(page, /:disabled="!queueOffer\.slots\.length"/);
  const slot = "2099-01-01T12:00:00.000Z";
  f.queueOffer.value = { ...f.queueOffer.value, showScheduledOffer: true,
    slots: [{ at: slot, reserved: 0, capacity: 1 }] };
  await nextTick();
  f.form.pickupTiming = "scheduled";
  f.form.pickupAt = slot;
  f.queueOffer.value = { ...f.queueOffer.value, slots: [] };
  await nextTick();
  assert.equal(f.form.pickupAt, "");
  await f.submit();
  assert.equal(f.state.requests.length, 0);
  assert.ok(f.errors.deliveryAt);
});

test("a failed checkout keeps its requestId for a deliberate retry", async t => {
  const f = await fixture(t);
  let first = true;
  f.state.post = async () => {
    if (first) { first = false; throw new Error("Response lost"); }
    return { publicId: "created-order" };
  };
  await f.submit();
  assert.equal(f.cart.count, 1);
  await f.submit();
  assert.equal(f.state.requests.length, 2);
  assert.equal(f.state.requests[0].body.checkoutRequestId,
    f.state.requests[1].body.checkoutRequestId);
  assert.equal(f.state.sessionCalls, 2);
  assert.deepEqual(f.state.navigation, ["/order/created-order"]);
});

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

test("self recipient defaults use verified account data and never trust an unverified Telegram phone", () => {
  const telegram = { connected: true, firstName: "Тест", lastName: "Покупатель",
    phoneNumber: "+79990000001", phoneVerified: true };
  assert.deepEqual(recipientDefaults({ name: "Аккаунт", phone: "+79990000002", telegram }),
    { name: "Аккаунт", phone: "+79990000002" });
  assert.deepEqual(recipientDefaults({ name: null, phone: null, telegram }),
    { name: "Тест Покупатель", phone: "+79990000001" });
  assert.deepEqual(recipientDefaults({ name: null, phone: null,
    telegram: { ...telegram, phoneVerified: false } }),
    { name: "Тест Покупатель", phone: "" });
});

test("recipient tabs retain independent drafts and other recipient owns no account data", async t => {
  const f = await fixture(t, true);
  const account = structuredClone(f.user);
  f.self.name = "Edited self";
  f.self.phone = "+79990000003";
  f.recipientMode.value = "other";
  Object.assign(f.other, { name: "Друг", phone: "+79990000004", city: "Москва",
    street: "Новая", house: "7", flat: "3", entrance: "1", floor: "2",
    intercom: "12", comment: "У двери" });
  await nextTick();
  assert.equal(f.recipient.value.name, "Друг");
  f.recipientMode.value = "self";
  assert.equal(f.recipient.value.name, "Edited self");
  assert.equal(f.recipient.value.phone, "+79990000003");
  f.recipientMode.value = "other";
  assert.equal(f.recipient.value.street, "Новая");
  await f.submit();
  const request = f.state.requests[0];
  assert.equal(request.path, "/cart/checkout");
  assert.equal(request.body.customerName, "Друг");
  assert.equal(request.body.customerPhone, "+79990000004");
  assert.deepEqual(request.body.address, {
    city: "Москва", street: "Новая", house: "7", flat: "3",
    entrance: "1", floor: "2", intercom: "12", comment: "У двери",
  });
  assert.equal(Object.hasOwn(request.body, "userId"), false);
  assert.deepEqual(f.user, account);
});

test("pickup for another recipient sends no address; self edits do not mutate profile", async t => {
  const f = await fixture(t, true);
  const account = structuredClone(f.user);
  f.self.name = "Order-only name";
  f.self.phone = "+79990000006";
  f.form.type = "PICKUP";
  await nextTick();
  f.recipientMode.value = "other";
  f.other.name = "Pickup friend";
  f.other.phone = "+79990000007";
  await f.submit();
  assert.equal(f.state.requests[0].body.customerName, "Pickup friend");
  assert.equal(f.state.requests[0].body.address, undefined);
  assert.deepEqual(f.user, account);
});

test("saved primary phone prefills self, selecting another saved phone stays order-only", async t => {
  const f = await fixture(t, true, true);
  assert.equal(f.state.phoneOptions.immediate, true);
  assert.equal(f.self.phone, "+79990000009");
  assert.equal(f.selectedPhone.value, "+79990000009");
  f.selectedPhone.value = "+79990000000";
  f.choosePhone();
  assert.equal(f.self.phone, "+79990000000");
  f.selectedPhone.value = "manual";
  f.choosePhone();
  f.self.phone = "+79998887766";
  f.onPhoneInput();
  assert.equal(f.selectedPhone.value, "manual");
  f.recipientMode.value = "other";
  assert.equal(f.other.phone, "");
  f.recipientMode.value = "self";
  assert.equal(f.self.phone, "+79998887766");
  assert.equal(f.user.phone, "+79990000000");
  assert.deepEqual(recipientDefaults(f.user, "", "+79990000009"),
    { name: "User", phone: "+79990000009" });
});

test("invalid guest checkout preserves cart, shows phone format error, focuses first visible field and restarts shake", async t => {
  const f = await fixture(t);
  f.recipient.value.name = "";
  f.recipient.value.phone = "+7 999";
  f.recipient.value.city = "";
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFrame = globalThis.requestAnimationFrame;
  const events = [];
  const field = {
    getClientRects: () => [{}],
    querySelector: () => ({ focus: options => events.push(["focus", options.preventScroll]) }),
    scrollIntoView: options => events.push(["scroll", options.behavior]),
  };
  globalThis.document = { querySelector: selector => {
    events.push(["query", selector]);
    return selector.includes('"name"') ? field : null;
  } };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.requestAnimationFrame = callback => callback();
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousFrame;
  });
  const shakes = [];
  const stop = watch(f.shakeFields, value => shakes.push([...value]), { flush: "sync" });
  t.after(stop);
  await f.submit();
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.cart.count, 1);
  assert.equal(f.errors.phone, "Введите корректный номер телефона");
  assert.deepEqual(events.slice(0, 3), [
    ["query", '[data-checkout-field="name"]'],
    ["scroll", "smooth"],
    ["focus", true],
  ]);
  await f.submit();
  assert.ok(shakes.some(value => value.length === 0), "animation class removed before restart");
  assert.equal(shakes.at(-1)[0], "name");
  f.recipient.value.name = "Guest";
  await nextTick();
  assert.equal(f.errors.name, "", "corrected field loses red error immediately");
});

test("reduced motion uses instant scroll; hidden delivery fields are skipped for pickup", async t => {
  const f = await fixture(t);
  f.form.type = "PICKUP";
  f.form.pickupTiming = "scheduled";
  f.form.pickupAt = "";
  f.recipient.value.city = "";
  f.recipient.value.street = "";
  f.recipient.value.house = "";
  await nextTick();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFrame = globalThis.requestAnimationFrame;
  const scrolls = [];
  const field = {
    getClientRects: () => [{}],
    querySelector: () => ({ focus() {} }),
    scrollIntoView: options => scrolls.push(options.behavior),
  };
  globalThis.document = { querySelector: selector =>
    selector.includes('"deliveryAt"') ? field : null };
  let onViewportResize;
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    visualViewport: {
      addEventListener: (_event, callback) => { onViewportResize = callback; },
      removeEventListener() {},
    },
  };
  globalThis.requestAnimationFrame = callback => callback();
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousFrame;
  });
  await f.submit();
  assert.equal(f.errors.city, "");
  assert.equal(f.errors.street, "");
  assert.equal(f.errors.house, "");
  assert.ok(f.errors.deliveryAt);
  assert.ok(scrolls.every(value => value === "instant"));
  const beforeKeyboard = scrolls.length;
  onViewportResize();
  assert.equal(scrolls.length, beforeKeyboard + 1, "keyboard resize reveals the focused error again");
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.cart.count, 1);
});

test("phone validation and neutral checkout placeholders match backend input shape", async () => {
  assert.equal(validOrderPhone("+7 (999) 123-45-67"), true);
  assert.equal(validOrderPhone("8 999 123 45 67"), true);
  assert.equal(validOrderPhone("+7 999"), false);
  assert.equal(validOrderPhone(""), false);
  const value = checkoutErrors({ name: "Guest", phone: "+7 999", city: "", street: "", house: "" },
    { type: "PICKUP", pickupTiming: "asap", pickupAt: "" });
  assert.ok(value.phone);
  assert.equal(value.city, "");
  for (const placeholder of ["Введите имя", "+7 (___) ___-__-__", "Название города",
    "Название улицы", "Номер дома", "Номер квартиры", "Номер подъезда",
    "Номер этажа", "Код домофона", "Комментарий для курьера"])
    assert.ok(page.includes('placeholder="' + placeholder + '"'), placeholder);
  assert.match(page, /prefers-reduced-motion:\s*reduce/);
  assert.match(page, /novalidate @submit\.prevent="submit"/);
  assert.match(page, /:aria-invalid="Boolean\(errors\.phone\)"/);
});

test("invalid saved delivery address opens its fields before checkout error navigation", async t => {
  const f = await fixture(t, true);
  assert.equal(f.selectedAddressId.value, f.address.id);
  f.self.city = "";
  await f.submit();
  assert.equal(f.selectedAddressId.value, null);
  assert.equal(f.errors.city, "Введите город");
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.cart.count, 1);
});
