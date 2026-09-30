import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, effectScope, nextTick, reactive, ref, watch } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useCartStore } from "../app/stores/cart.ts";
import { decodeCart } from "../app/utils/cart.ts";

const source = await readFile(new URL("../app/plugins/cart.client.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("cart.client.ts", source, ts.ScriptTarget.Latest, true);
let executable = source;
for (const statement of [...parsed.statements].reverse())
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace("export default", "return");

const product = {
  id: 1, name: "Apple", slug: "apple", price: 10000, priceQty: 1000,
  unit: "GRAM", min: 500, step: 100, portionQty: 500, images: [],
  category: { name: "Fruit", slug: "fruit" },
};
const guestRaw = JSON.stringify({ version: 1, items: [{ product, qty: 500 }] });
const snapshot = (qty, revision = "1") => ({
  revision,
  items: qty ? [{ productId: 1, qty, product, status: "AVAILABLE", lineTotal: qty * 10 }] : [],
  products: qty ? [product] : [],
  subtotal: qty * 10, valid: true, error: null, token: revision,
});

function fixture(authenticated, failMerge = false, initial = guestRaw) {
  setActivePinia(createPinia());
  const cart = useCartStore();
  const auth = reactive({ user: authenticated ? { id: 1, role: "USER" } : null });
  let saved = initial;
  let writes = 0;
  let removals = 0;
  let mergeBodies = [];
  let server = snapshot(0);
  const storage = {
    getItem: key => { assert.equal(key, "cart"); return saved; },
    setItem: (key, value) => { assert.equal(key, "cart"); writes++; saved = value; },
    removeItem: key => { assert.equal(key, "cart"); removals++; saved = null; },
  };
  const api = async (path, options) => {
    if (path === "/cart") return server;
    assert.equal(path, "/cart/merge");
    mergeBodies.push(options.body);
    if (failMerge) throw { statusCode: 400 };
    server = snapshot(500, "2");
    return server;
  };
  const listeners = new Map();
  const hooks = new Map();
  const install = new Function(
    "defineNuxtPlugin", "useCartStore", "useAuthStore", "useApiClient",
    "decodeCart", "localStorage", "watch", "window", "document", executable,
  )(
    setup => setup, () => cart, () => auth, () => api,
    decodeCart, storage, watch,
    { addEventListener: (name, fn) => listeners.set(name, fn),
      location: { pathname: "/cart" } },
    { addEventListener: (name, fn) => listeners.set(name, fn),
      visibilityState: "visible" },
  );
  install({ hooks: { hook: (name, fn) => hooks.set(name, fn) } });
  return { cart, auth, finish: hooks.get("page:finish"), listeners,
    get saved() { return saved; }, get writes() { return writes; },
    get removals() { return removals; }, get mergeBodies() { return mergeBodies; },
    botSet(qty) { server = snapshot(qty, "3"); } };
}

async function settled() {
  for (let i = 0; i < 5; i++) await nextTick();
  await new Promise(resolve => setImmediate(resolve));
}

test("authenticated launch merges guest once and never persists server cart to localStorage", async () => {
  const f = fixture(true);
  f.finish();
  await settled();
  assert.equal(f.cart.mode, "server");
  assert.equal(f.cart.restored, true);
  assert.equal(f.cart.qty(1), 500);
  assert.equal(f.cart.additionRevision, 0);
  assert.equal(f.saved, null);
  assert.equal(f.removals, 1);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.mergeBodies[0].items, [{ productId: 1, qty: 500 }]);
  f.botSet(800);
  f.listeners.get("focus")();
  await settled();
  assert.equal(f.cart.qty(1), 800);
  assert.equal(f.cart.additionRevision, 0);
  assert.equal(f.writes, 0);
});

test("failed merge keeps guest localStorage while server remains authoritative", async () => {
  const f = fixture(true, true);
  f.finish();
  await settled();
  assert.equal(f.cart.mode, "server");
  assert.equal(f.cart.restored, true);
  assert.equal(f.cart.count, 0);
  assert.equal(f.saved, guestRaw);
  assert.equal(f.removals, 0);
  assert.ok(f.cart.storageWarning);
});

test("guest cart created before login is merged from memory and is not lost", async () => {
  const f = fixture(false);
  f.finish();
  assert.equal(f.cart.mode, "guest");
  assert.equal(f.cart.qty(1), 500);
  f.cart.add(product);
  await settled();
  assert.equal(f.cart.qty(1), 1000);
  f.auth.user = { id: 1, role: "USER" };
  await settled();
  assert.equal(f.cart.mode, "server");
  assert.equal(f.cart.restored, true);
  assert.equal(f.mergeBodies[0].items[0].qty, 1000);
  assert.equal(f.cart.additionRevision, 0);
  assert.equal(f.saved, null);
});

test("failed merge after an immediate guest edit retains the latest draft on logout", async () => {
  const f = fixture(false, true);
  f.finish();
  f.cart.add(product);
  assert.equal(f.cart.qty(1), 1000);
  f.auth.user = { id: 1, role: "USER" };
  await settled();
  assert.equal(f.cart.mode, "server");
  assert.equal(f.cart.count, 0);
  assert.equal(JSON.parse(f.saved).items[0].qty, 1000);
  f.auth.user = null;
  await settled();
  assert.equal(f.cart.mode, "guest");
  assert.equal(f.cart.qty(1), 1000);
});

test("a later guest session merges its new items after an earlier empty login", async () => {
  const f = fixture(true, false, null);
  f.finish();
  await settled();
  assert.equal(f.cart.mode, "server");
  assert.equal(f.mergeBodies.length, 0);
  f.auth.user = null;
  await settled();
  f.cart.add(product);
  f.auth.user = { id: 1, role: "USER" };
  await settled();
  assert.equal(f.mergeBodies.length, 1);
  assert.equal(f.mergeBodies[0].items[0].qty, 500);
});

test("retry after failed merge uses newer guest edits", async () => {
  const f = fixture(false, true);
  f.finish();
  f.auth.user = { id: 1, role: "USER" };
  await settled();
  f.auth.user = null;
  await settled();
  f.cart.add(product);
  assert.equal(f.cart.qty(1), 1000);
  f.auth.user = { id: 1, role: "USER" };
  await settled();
  assert.equal(f.mergeBodies.at(-1).items[0].qty, 1000);
});

test("TEST_PHONE login uses the existing guest-to-server cart merge", async t => {
  const f = fixture(false);
  f.finish();
  f.auth.set = function (user) { this.user = user; };
  const source = await readFile(new URL("../app/components/auth/Modal.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile("Modal.ts", script, ts.ScriptTarget.Latest, true);
  let executable = script;
  for (const statement of [...parsed.statements].reverse())
    if (ts.isImportDeclaration(statement))
      executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
  executable = ts.transpileModule(executable, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const open = ref(true);
  const requests = [];
  const context = {
    defineModel: () => open,
    useAuthStore: () => f.auth,
    useApiClient: () => async (path, options) => {
      requests.push(path);
      if (path === "/auth/telegram/config") return { websiteAvailable: true };
      if (path === "/auth/method") return { method: "TEST_PHONE" };
      if (path === "/auth/test-phone-login")
        return { id: 42, role: "USER", phone: options.body.phone, verifiedAt: null };
      throw new Error(`Unexpected auth route: ${path}`);
    },
    useAdminLogin: () => async () => { throw new Error("Admin route must not run"); },
    useToast: () => ({ add() {} }),
    useRoute: () => ({ path: "/" }),
    useLoginMethod: () => ({
      mode: ref("TEST_PHONE"), error: ref(null), change() {}, reset() {},
    }),
    apiError: () => "Login failed",
    ref, computed, watch, onBeforeUnmount: () => {},
  };
  const setup = new Function(...Object.keys(context),
    executable + "\nreturn { phone, submit };");
  const scope = effectScope();
  t.after(() => scope.stop());
  const modal = scope.run(() => setup(...Object.values(context)));
  modal.phone.value = "+79990000002";
  await modal.submit();
  await settled();
  assert.ok(requests.includes("/auth/test-phone-login"));
  assert.equal(f.auth.user.id, 42);
  assert.equal(f.cart.mode, "server");
  assert.equal(f.cart.qty(1), 500);
  assert.deepEqual(f.mergeBodies[0].items, [{ productId: 1, qty: 500 }]);
  assert.equal(f.saved, null);
  assert.equal(f.removals, 1);
});
