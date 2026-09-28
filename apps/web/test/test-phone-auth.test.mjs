import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, effectScope, ref, watch } from "vue";
import { useLoginMethod } from "../app/composables/useLoginMethod.ts";

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

test("TEST_PHONE AuthModal signs in directly and triggers the ordinary auth-store transition", async t => {
  const scope = effectScope();
  t.after(() => scope.stop());
  const calls = [];
  const toasts = [];
  const user = { id: 17, role: "USER", phone: "+79990000002", verifiedAt: null };
  const auth = { user: null, set(value) { this.user = value; } };
  const open = ref(true);
  const context = {
    defineModel: () => open,
    useAuthStore: () => auth,
    useApiClient: () => async (path, options) => {
      calls.push({ path, options });
      if (path === "/auth/telegram/config") return { websiteAvailable: true };
      if (path === "/auth/method") return { method: "TEST_PHONE" };
      if (path === "/auth/test-phone-login") return user;
      throw new Error(`Unexpected API route: ${path}`);
    },
    useAdminLogin: () => async () => { throw new Error("Admin login must not run"); },
    useToast: () => ({ add: toast => toasts.push(toast) }),
    useRoute: () => ({ path: "/" }),
    useLoginMethod,
    apiError: () => "Login failed",
    ref, computed, watch,
    onBeforeUnmount: () => {},
  };
  const setup = new Function(...Object.keys(context),
    executable + "\nreturn { open, phone, mode, change, submit, codeSent, password };");
  const modal = scope.run(() => setup(...Object.values(context)));
  modal.phone.value = "+79990000002";
  modal.change(modal.phone.value, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(modal.mode.value, "TEST_PHONE");
  await modal.submit();
  assert.deepEqual(calls.map(call => call.path),
    ["/auth/telegram/config", "/auth/method", "/auth/test-phone-login"]);
  assert.deepEqual(calls.at(-1).options.body, { phone: user.phone });
  assert.equal(auth.user, user);
  assert.equal(modal.open.value, false);
  assert.equal(modal.codeSent.value, false);
  assert.equal(modal.password.value, "");
  assert.deepEqual(toasts, [{ title: "Вы вошли" }]);
});

test("TEST_PHONE template has a direct submit and notice without OTP or password fields", () => {
  assert.match(source, /mode === "TEST_PHONE"[\s\S]*?"Войти или зарегистрироваться"/);
  assert.match(source, /Тестовый режим: подтверждение номера телефона временно отключено/);
  assert.match(source, /v-if="mode === 'PASSWORD'" label="Пароль"/);
  assert.match(source, /v-if="mode === 'OTP' && codeSent"/);
});
