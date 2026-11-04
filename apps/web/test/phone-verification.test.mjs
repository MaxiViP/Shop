import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { ref } from "vue";
import { apiError } from "../app/utils/api-error.ts";

const source = await readFile(new URL("../app/components/auth/PhoneVerification.vue", import.meta.url), "utf8");
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile("PhoneVerification.ts", script, ts.ScriptTarget.Latest, true);
let executable = script;
for (const statement of [...parsed.statements].reverse())
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture(options = {}) {
  const initial = { id: 10, phone: null, verifiedAt: null, telegram: { connected: true } };
  const auth = { user: initial, set(user) { this.user = user; } };
  const calls = [];
  const navigation = [];
  let mounted;
  const context = {
    ref, apiError,
    useAuthStore: () => auth,
    onMounted: callback => { mounted = callback; },
    window: { location: { assign: url => navigation.push(url) } },
    useApiClient: () => async (path, input) => {
      calls.push({ path, input });
      if (path === "/auth/telegram/config") return { websiteAvailable: true };
      if (path === "/auth/code") return options.codeResponse ?? { ok: true };
      if (path === "/auth/telegram/start") return { url: "https://oauth.telegram.org/auth" };
      assert.equal(path, "/auth/login");
      if (options.conflict) throw { data: { message: "ACCOUNT_LINK_REQUIRED" } };
      return { ...initial, phone: "+79990000010", verifiedAt: "2026-11-03T00:00:00Z" };
    },
  };
  const setup = new Function(...Object.keys(context), executable + "\nreturn { phone, code, sent, loading, error, submit, telegramLogin, reset };");
  return { ...setup(...Object.values(context)), initial, auth, calls, navigation, mount: () => mounted() };
}

test("legacy account requests a real OTP and updates the same profile after verification", async () => {
  const f = fixture();
  f.phone.value = "+79990000010";
  await f.submit();
  assert.equal(f.sent.value, true);
  assert.equal(f.auth.user, f.initial);
  f.code.value = "123456";
  await f.submit();
  assert.deepEqual(f.calls.map(call => call.path), ["/auth/code", "/auth/login"]);
  assert.deepEqual(f.calls[1].input.body, { phone: "+79990000010", code: "123456" });
  assert.equal(f.auth.user.id, 10);
  assert.equal(f.auth.user.phone, "+79990000010");
  assert.ok(f.auth.user.verifiedAt);
});

test("demo codes never submit a login or change the Telegram-only account", async () => {
  const f = fixture({ codeResponse: { demoCode: "123456" } });
  await f.submit();
  assert.equal(f.sent.value, false);
  assert.match(f.error.value, /не подтверждает номер/);
  assert.equal(f.auth.user, f.initial);
  assert.deepEqual(f.calls.map(call => call.path), ["/auth/code"]);
});

test("phone conflict preserves the profile and displays the safe error", async () => {
  const f = fixture({ conflict: true });
  await f.submit();
  f.code.value = "123456";
  await f.submit();
  assert.equal(f.auth.user, f.initial);
  assert.equal(f.loading.value, false);
  assert.match(f.error.value, /отдельный процесс подтверждения/);
});

test("Telegram verification starts the server OIDC flow without submitting cached phone data", async () => {
  const f = fixture();
  await f.mount();
  await f.telegramLogin();
  assert.deepEqual(f.calls.at(-1), { path: "/auth/telegram/start", input: { method: "POST" } });
  assert.deepEqual(f.navigation, ["https://oauth.telegram.org/auth"]);
});
