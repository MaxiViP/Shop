import assert from "node:assert/strict";
import test from "node:test";
import { telegramReturnTo } from "../app/utils/telegram-return.ts";
import { apiError } from "../app/utils/api-error.ts";

test("account linking conflict is readable and never suggests an automatic merge", () => {
  const message = apiError({ data: { message: "ACCOUNT_LINK_REQUIRED" } });
  assert.match(message, /отдельный процесс подтверждения/);
  assert.ok(!message.includes("ACCOUNT_LINK_REQUIRED"));
  assert.equal(apiError({ message: "ACCOUNT_LINK_REQUIRED" }), message);
});

test("Telegram proof errors remain generic and safe", () => {
  for (const code of ["TELEGRAM_AUTH_INVALID", "TELEGRAM_AUTH_REPLAY", "TELEGRAM_LOGIN_UNAVAILABLE"])
    assert.ok(!apiError({ data: { message: code } }).includes(code));
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

function miniAppPage(options = {}) {
  const requests = [];
  const navigation = [];
  let mounted;
  let unmount;
  let readyCalls = 0;
  const auth = { user: options.cachedUser ?? null, set(value) { this.user = value; } };
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
      get Telegram() {
        if (options.sdkMissing) return undefined;
        return { WebApp: {
          initData: options.initData ?? "signed-test-proof",
          ready() { readyCalls++; },
        } };
      },
    },
    document: { createElement() { throw new Error("SDK_UNAVAILABLE"); } },
  };
  const setup = new Function(...Object.keys(context), executable + "\nreturn { message, showFallback };");
  const result = setup(...Object.values(context));
  return { ...result, auth, requests, navigation,
    mount: () => mounted(), unmount: () => unmount(), readyCalls: () => readyCalls };
}

test("normal entry retains the existing SID shortcut", async () => {
  const instance = miniAppPage({ session: user });
  await instance.mount();
  assert.deepEqual(instance.requests.map(x => x.path), ["/auth/me"]);
  assert.deepEqual(instance.navigation, [["/catalog", { replace: true }]]);
});

test("normal entry without SID still verifies Mini App initData", async () => {
  const instance = miniAppPage();
  await instance.mount();
  assert.deepEqual(instance.requests.map(x => x.path), ["/auth/me", "/auth/telegram/mini-app"]);
  assert.deepEqual(instance.navigation, [["/catalog", { replace: true }]]);
});

test("WebApp returnTo posts proof before any /auth/me for every customer destination", async () => {
  const destinations = [
    "/", "/catalog", "/catalog/vegetables", "/product/green-grapes",
    "/order/11111111-1111-4111-8111-111111111111", "/orders", "/profile",
    "/cart", "/favorites", "/delivery",
  ];
  for (const target of destinations) {
    const instance = miniAppPage({ query: { returnTo: target } });
    await instance.mount();
    assert.deepEqual(instance.requests, [{
      path: "/auth/telegram/mini-app",
      input: { method: "POST", body: { initData: "signed-test-proof" } },
    }]);
    assert.equal(instance.readyCalls(), 1);
    assert.equal(instance.auth.user, user);
    assert.deepEqual(instance.navigation, [[target, { replace: true }]]);
    assert.equal(instance.showFallback.value, false);
  }
});

test("external, protected, encoded and malformed destinations fall back to catalog", async () => {
  for (const target of ["https://evil.example", "//evil.example", "javascript:alert(1)",
    "/\\evil", "/%2F%2Fevil", "/product/../admin", "/product/a%2Fb",
    "/admin", "/admin/products", "/staff", "/staff/orders", "/api",
    "/api/orders", "/telegram", "/telegram?returnTo=/profile",
    "/product/a?next=//evil.example", "/order/not-uuid", "/cart\u0000"]) {
    assert.equal(telegramReturnTo(target), "/catalog");
    const instance = miniAppPage({ query: { returnTo: target } });
    await instance.mount();
    assert.deepEqual(instance.requests.map(x => x.path), ["/auth/telegram/mini-app"]);
    assert.deepEqual(instance.navigation, [["/catalog", { replace: true }]]);
  }
});

test("verified CUSTOMER replaces an existing ADMIN browser SID after proof verification", async () => {
  const admin = { ...user, id: 99, role: "ADMIN" };
  const instance = miniAppPage({ cachedUser: admin, session: admin,
    query: { returnTo: "/product/apple" } });
  await instance.mount();
  assert.deepEqual(instance.requests.map(x => x.path), ["/auth/telegram/mini-app"]);
  assert.equal(instance.auth.user, user);
  assert.deepEqual(instance.navigation, [["/product/apple", { replace: true }]]);
});

test("invalid proof cannot replace the existing ADMIN store or navigate", async () => {
  const admin = { ...user, id: 99, role: "ADMIN" };
  const instance = miniAppPage({ cachedUser: admin,
    query: { returnTo: "/profile" }, authError: { data: { message: "TELEGRAM_AUTH_INVALID" } } });
  await instance.mount();
  assert.equal(instance.auth.user, admin);
  assert.deepEqual(instance.requests.map(x => x.path), ["/auth/telegram/mini-app"]);
  assert.deepEqual(instance.navigation, []);
  assert.equal(instance.showFallback.value, true);
});

test("repeated launches submit the same signed initData without a browser replay marker", async () => {
  for (const target of ["/product/apple", "/orders"]) {
    const instance = miniAppPage({ query: { returnTo: target }, session: user });
    await instance.mount();
    assert.deepEqual(instance.requests.map(x => x.path), ["/auth/telegram/mini-app"]);
    assert.deepEqual(instance.navigation, [[target, { replace: true }]]);
  }
});

test("missing initData or SDK shows a safe fallback without making a login request", async () => {
  for (const options of [{ initData: "" }, { sdkMissing: true }]) {
    const instance = miniAppPage({ ...options, query: { returnTo: "/profile" } });
    await instance.mount();
    assert.deepEqual(instance.requests, []);
    assert.deepEqual(instance.navigation, []);
    assert.equal(instance.showFallback.value, true);
  }
});

test("unmount before the Mini App response prevents navigation and store update", async () => {
  let complete;
  const authResponse = new Promise(resolve => { complete = resolve; });
  const instance = miniAppPage({ authResponse, query: { returnTo: "/product/apple" } });
  const mounting = instance.mount();
  assert.deepEqual(instance.requests.map(x => x.path), ["/auth/telegram/mini-app"]);
  instance.unmount();
  complete(user);
  await mounting;
  assert.equal(instance.auth.user, null);
  assert.deepEqual(instance.navigation, []);
});

test("ordinary OIDC error page keeps a safe fallback", async () => {
  const instance = miniAppPage({ query: { error: "login" } });
  await instance.mount();
  assert.deepEqual(instance.requests.map(x => x.path), ["/auth/me"]);
  assert.equal(instance.showFallback.value, true);
  assert.deepEqual(instance.navigation, []);
});
