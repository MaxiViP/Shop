import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { ref, computed, reactive, watch, nextTick } from "vue";

const source = await readFile(new URL("../app/pages/order/[id].vue", import.meta.url), "utf8");
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);
const parsed = ts.createSourceFile("order.ts", script, ts.ScriptTarget.Latest, true);
let body = script;
for (const statement of [...parsed.statements].reverse()) {
  if (ts.isImportDeclaration(statement))
    body = body.slice(0, statement.getStart()) + body.slice(statement.end);
}
body = ts.transpileModule(body, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
}}).outputText;

const id = "12345678-1234-4234-8234-123456789abc";
const order = { id: 7, publicId: id, status: "NEW", type: "PICKUP", items: [] };
function error(statusCode) { return { statusCode }; }

async function page({ user = null, response = null, failure = null, afterLogin = order } = {}) {
  const auth = reactive({ user });
  const data = ref(response);
  const apiError = ref(failure);
  const calls = [];
  let mounted;
  let shownError;
  const refresh = async () => {
    calls.push("refresh");
    data.value = afterLogin;
    apiError.value = afterLogin ? null : error(404);
  };
  const ctx = {
    ref, computed, watch,
    useRoute: () => ({ params: { id } }),
    useAuthStore: () => auth,
    useApi: async path => {
      calls.push(path);
      return { data, error: apiError, refresh };
    },
    createError: value => value,
    showError: value => { shownError = value; },
    onMounted: fn => { mounted = fn; },
    onBeforeUnmount: () => {},
    useSeoMeta: () => {},
    isActiveOrder: () => false,
    orderMeta: () => ({ label: "Новый" }),
    deliveryProvider: () => "", deliveryStatus: () => "",
    knownMoney: () => "", money: () => "", qtyText: () => "", pickupTime: () => "",
    document: { visibilityState: "hidden" },
    setInterval: () => 1, clearInterval: () => {},
  };
  const fn = new (async () => {}).constructor(...Object.keys(ctx),
    body + "\nreturn { loginOpen, data, error };");
  const result = await fn(...Object.values(ctx));
  return { ...result, auth, calls, mount: () => mounted(), shownError: () => shownError };
}

test("unauthenticated order link opens existing AuthModal instead of false 404", async () => {
  assert.match(source, /<AuthModal v-model:open="loginOpen"/);
  assert.match(source, /<template v-if="order">/);
  const p = await page({ failure: error(404) });
  p.mount();
  assert.equal(p.loginOpen.value, true);
  assert.deepEqual(p.calls, ["/orders/" + id]);
});

test("authenticated owner opens the order", async () => {
  const p = await page({ user: { id: 7 }, response: order });
  p.mount();
  assert.equal(p.loginOpen.value, false);
  assert.equal(p.data.value.id, 7);
});

test("authenticated foreign/missing order remains 404", async () => {
  await assert.rejects(page({ user: { id: 8 }, failure: error(404) }),
    rejected => rejected.statusCode === 404);
});

test("unexpected API failure becomes service error, not 404", async () => {
  await assert.rejects(page({ failure: error(500) }),
    rejected => rejected.statusCode === 503);
});

test("login on the same page refreshes the exact order without reopening the link", async () => {
  const p = await page({ failure: error(404) });
  p.mount();
  p.auth.user = { id: 7 };
  await nextTick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.calls, ["/orders/" + id, "refresh"]);
  assert.equal(p.data.value.id, 7);
  assert.equal(p.shownError(), undefined);
});

const modalSource = await readFile(new URL("../app/components/auth/Modal.vue", import.meta.url), "utf8");
const modalScript = modalSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
assert.ok(modalScript);
const modalAst = ts.createSourceFile("modal.ts", modalScript, ts.ScriptTarget.Latest, true);
const telegramFn = modalAst.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "telegramLogin");
assert.ok(telegramFn);
const telegramCode = ts.transpileModule(telegramFn.getText(modalAst), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

async function telegramStart(path) {
  const calls = [], navigation = [];
  const loading = ref(false), telegramAvailable = ref(true), telegramLoading = ref(false), error = ref("");
  const api = async (target, init) => {
    calls.push({ target, init });
    return { url: "https://oauth.telegram.org/auth?fixture=1" };
  };
  const route = { path };
  const browser = { location: { assign: url => navigation.push(url) } };
  const fn = new Function("api", "route", "loading", "telegramAvailable", "telegramLoading", "error", "window",
    telegramCode + "\nreturn telegramLogin;");
  await fn(api, route, loading, telegramAvailable, telegramLoading, error, browser)();
  return { calls, navigation };
}

test("Telegram modal sends exact order returnTo and no token in start payload", async () => {
  const result = await telegramStart("/order/" + id);
  assert.deepEqual(result.calls, [{
    target: "/auth/telegram/start",
    init: { method: "POST", body: { returnTo: "/order/" + id } },
  }]);
  assert.equal(result.navigation.length, 1);
  const upper = await telegramStart('/order/ABCDEF12-1234-4234-8234-ABCDEF123456');
  assert.equal(upper.calls[0].init.body.returnTo, '/order/ABCDEF12-1234-4234-8234-ABCDEF123456');
});

test("Telegram modal omits external or malformed returnTo", async () => {
  for (const path of ["//evil.example", "/order/%2f%2fevil", "/order/" + id + "?next=evil",
    "/order/" + id + "\\evil", "https://evil.example/order/" + id]) {
    const result = await telegramStart(path);
    assert.deepEqual(result.calls[0].init, { method: "POST" });
  }
});
