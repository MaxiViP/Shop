import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { telegramReturnTo } from "../app/utils/telegram-return.ts";
import { apiError } from "../app/utils/api-error.ts";

test("account linking conflict is readable and never suggests an automatic merge", () => {
  const message = apiError({ data: { message: "ACCOUNT_LINK_REQUIRED" } });
  assert.match(message, /отдельный процесс подтверждения/);
  assert.ok(!message.includes("ACCOUNT_LINK_REQUIRED"));
  assert.equal(apiError({ message: "ACCOUNT_LINK_REQUIRED" }), message);
});

test("Telegram proof errors give a safe retry path", () => {
  for (const code of ["TELEGRAM_AUTH_INVALID", "TELEGRAM_AUTH_REPLAY", "TELEGRAM_LOGIN_UNAVAILABLE"]) {
    assert.ok(!apiError({ data: { message: code } }).includes(code));
  }
  assert.match(apiError({ data: { message: "TELEGRAM_AUTH_REPLAY" } }), /заново откройте/);
});

test("other API validation messages remain intact", () => {
  assert.equal(apiError({ data: { message: ["Первое", "Второе"] } }), "Первое. Второе");
  assert.equal(apiError({ data: { message: "Исходная ошибка" } }), "Исходная ошибка");
});

const { readFile } = await import("node:fs/promises");
const { default: ts } = await import("typescript");
const { ref } = await import("vue");
const page = await readFile(new URL("../app/pages/telegram.vue", import.meta.url), "utf8");
const script = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile("telegram.ts", script, ts.ScriptTarget.Latest, true);
let executable = script;
for (const statement of [...parsed.statements].reverse()) {
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
}
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const user = { id: 7, phone: null, name: "Test", role: "USER", verifiedAt: null };

// Execute the actual page setup and mounted callback; no browser, network or
// component framework. The SDK fixture contains only the public initData contract.
function miniAppPage(options = {}) {
  const requests = [];
  const navigation = [];
  let mounted;
  let unmount;
  let sdkReads = 0;
  let readyCalls = 0;
  const auth = { user: options.cachedUser ?? null, set(value) { this.user = value; } };
  const storage = options.storage ?? new Map();
  const context = {
    ref, apiError, telegramReturnTo,
    useSeoMeta: () => {},
    useRoute: () => ({ query: options.query ?? {} }),
    useAuthStore: () => auth,
    useApiClient: () => async (path, input) => {
      requests.push({ path, input });
      if (path === "/auth/me") {
        if (options.sessionError) throw options.sessionError;
        return options.session ?? null;
      }
      assert.equal(path, "/auth/telegram/mini-app");
      if (options.authError) throw options.authError;
      return options.authResponse ?? user;
    },
    onMounted: callback => { mounted = callback; },
    onBeforeUnmount: callback => { unmount = callback; },
    navigateTo: async (...args) => { navigation.push(args); },
    window: {
      crypto: webcrypto,
      sessionStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      get Telegram() {
        sdkReads++;
        return { WebApp: {
          initData: options.initData ?? "signed-test-proof",
          ready() { readyCalls++; },
        } };
      },
    },
    document: { createElement() { throw new Error("Unexpected SDK load"); } },
  };
  const setup = new Function(...Object.keys(context), executable + "\nreturn { message };");
  const result = setup(...Object.values(context));
  return { ...result, auth, requests, navigation, storage,
    mount: () => mounted(), unmount: () => unmount(),
    sdkReads: () => sdkReads, readyCalls: () => readyCalls };
}

test("existing SID session skips initData POST and SDK access even after reload", async () => {
  const page = miniAppPage({ session: user, query: { error: "login" } });
  await page.mount();
  assert.deepEqual(page.requests.map(item => item.path), ["/auth/me"]);
  assert.equal(page.auth.user, user);
  assert.equal(page.sdkReads(), 0);
  assert.deepEqual(page.navigation, [["/catalog", { replace: true }]]);
});

test("no session plus initData posts the proof exactly once after /auth/me", async () => {
  const page = miniAppPage();
  await page.mount();
  assert.deepEqual(page.requests, [
    { path: "/auth/me", input: undefined },
    { path: "/auth/telegram/mini-app", input: { method: "POST", body: { initData: "signed-test-proof" } } },
  ]);
  assert.equal(page.readyCalls(), 1);
  assert.equal(page.auth.user, user);
  assert.deepEqual(page.navigation, [["/catalog", { replace: true }]]);
});

test("expired cached auth store does not replace authoritative session check", async () => {
  const page = miniAppPage({ cachedUser: user, session: null });
  await page.mount();
  assert.deepEqual(page.requests.map(item => item.path), ["/auth/me", "/auth/telegram/mini-app"]);
});

test("missing session and initData produce a clear non-loading state", async () => {
  const page = miniAppPage({ initData: "" });
  await page.mount();
  assert.match(page.message.value, /Откройте мини-приложение из Telegram/);
  assert.deepEqual(page.requests.map(item => item.path), ["/auth/me"]);
  assert.deepEqual(page.navigation, []);
});

test("replay/backend error is shown without retry or fake authenticated state", async () => {
  for (const code of ["TELEGRAM_AUTH_REPLAY", "TELEGRAM_AUTH_INVALID"]) {
    const page = miniAppPage({ authError: { data: { message: code } } });
    await page.mount();
    assert.equal(page.message.value, apiError({ data: { message: code } }));
    assert.equal(page.auth.user, null);
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.navigation, []);
  }
});

test("unavailable /auth/me does not consume a proof as if the session were absent", async () => {
  const page = miniAppPage({ sessionError: { data: { message: "Сервис временно недоступен" } } });
  await page.mount();
  assert.equal(page.message.value, "Сервис временно недоступен");
  assert.deepEqual(page.requests.map(item => item.path), ["/auth/me"]);
  assert.equal(page.sdkReads(), 0);
  assert.deepEqual(page.navigation, []);
});

test("unmount while checking SID prevents subsequent auth POST or navigation", async () => {
  let complete;
  const session = new Promise(resolve => { complete = resolve; });
  const page = miniAppPage({ session });
  const mounting = page.mount();
  page.unmount();
  complete(null);
  await mounting;
  assert.deepEqual(page.requests.map(item => item.path), ["/auth/me"]);
  assert.equal(page.sdkReads(), 0);
  assert.deepEqual(page.navigation, []);
});

test('validated order and product returnTo navigate only after Mini App authentication', async () => {
  for (const target of ['/order/11111111-1111-4111-8111-111111111111', '/product/green-grapes']) {
    const page = miniAppPage({ query: { returnTo: target } });
    await page.mount();
    assert.deepEqual(page.requests.map(item => item.path), ['/auth/me', '/auth/telegram/mini-app']);
    assert.deepEqual(page.navigation, [[target, { replace: true }]]);
  }
});

test('external, encoded and malformed returnTo fall back to catalog', async () => {
  for (const target of ['https://evil.example', '//evil.example', '/\\evil', '/%2F%2Fevil',
    '/product/../admin', '/product/a%2Fb', '/order/not-uuid']) {
    assert.equal(telegramReturnTo(target), '/catalog');
    const page = miniAppPage({ query: { returnTo: target } });
    await page.mount();
    assert.deepEqual(page.navigation, [['/catalog', { replace: true }]]);
  }
});

test('a different existing SID is switched to the verified Mini App user', async () => {
  const admin = { ...user, id: 99, role: 'ADMIN' };
  const page = miniAppPage({ session: admin, query: { returnTo: '/product/apple' } });
  await page.mount();
  assert.deepEqual(page.requests.map(item => item.path), ['/auth/me', '/auth/telegram/mini-app']);
  assert.equal(page.auth.user, user);
  assert.deepEqual(page.navigation, [['/product/apple', { replace: true }]]);
});

test('a proven same-WebApp session skips replay of the same initData on reload', async () => {
  const storage = new Map();
  const query = { returnTo: '/product/apple' };
  const first = miniAppPage({ storage, query });
  await first.mount();
  const again = miniAppPage({ storage, query, session: user });
  await again.mount();
  assert.deepEqual(again.requests.map(item => item.path), ['/auth/me']);
  assert.deepEqual(again.navigation, [['/product/apple', { replace: true }]]);
  const switched = miniAppPage({ storage, query, session: { ...user, id: 99 }, initData: 'different-proof' });
  await switched.mount();
  assert.deepEqual(switched.requests.map(item => item.path), ['/auth/me', '/auth/telegram/mini-app']);
  assert.ok(!String([...storage.values()]).includes('signed-test-proof'));
});

test('missing initData on a WebApp order launch does not use an unrelated SID', async () => {
  const page = miniAppPage({ session: { ...user, id: 99 }, initData: '',
    query: { returnTo: '/order/11111111-1111-4111-8111-111111111111' } });
  await page.mount();
  assert.deepEqual(page.requests.map(item => item.path), ['/auth/me']);
  assert.deepEqual(page.navigation, []);
  assert.match(page.message.value, /Откройте мини-приложение/);
});

test('successful auth response after unmount preserves replay-safe proof marker', async () => {
  const storage = new Map();
  let complete;
  const authResponse = new Promise(resolve => { complete = resolve; });
  const query = { returnTo: '/product/apple' };
  const page = miniAppPage({ storage, query, authResponse });
  const mounting = page.mount();
  while (!page.requests.some(item => item.path === '/auth/telegram/mini-app'))
    await new Promise(resolve => setImmediate(resolve));
  page.unmount();
  complete(user);
  await mounting;
  assert.deepEqual(page.navigation, []);
  const again = miniAppPage({ storage, query, session: user });
  await again.mount();
  assert.deepEqual(again.requests.map(item => item.path), ['/auth/me']);
  assert.deepEqual(again.navigation, [['/product/apple', { replace: true }]]);
});
