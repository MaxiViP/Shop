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

async function fixture(t, codeResult = { ok: true }, options = {}) {
  const scope = effectScope();
  t.after(() => scope.stop());
  const calls = [];
  const toasts = [];
  const pauses = [];
  let timerId = 0;
  const user = { id: 19, role: "USER", phone: "+79990000002", verifiedAt: null };
  const auth = { user: null, set(value) { this.user = value; } };
  const open = ref(true);
  const context = {
    defineModel: () => open,
    useAuthStore: () => auth,
    useApiClient: () => async (path, request) => {
      calls.push({ path, request });
      if (path === "/auth/telegram/config") return { websiteAvailable: true };
      if (path === "/auth/method") return { method: "OTP" };
      if (path === "/auth/code") return codeResult;
      if (path === "/auth/login") {
        if (options.loginError) throw new Error("Login failed");
        return options.loginResponse ?? user;
      }
      throw new Error("Unexpected API route: " + path);
    },
    useAdminLogin: () => async () => { throw new Error("Admin password flow must not run"); },
    useToast: () => ({ add: value => toasts.push(value) }),
    useRoute: () => ({ path: "/" }),
    useLoginMethod,
    apiError: cause => cause.message ?? "Login failed",
    ref, computed, watch,
    onBeforeUnmount: callback => t.after(callback),
    setTimeout: (callback, ms) => {
      const task = { id: ++timerId, callback, ms, cancelled: false };
      pauses.push(task);
      return task.id;
    },
    clearTimeout: id => {
      const task = pauses.find(value => value.id === id);
      if (task) task.cancelled = true;
    },
  };
  const setup = new Function(...Object.keys(context),
    executable + "\nreturn { open, phone, code, codeSent, demoCode, otpStage, loading, message, mode, change, submit, onOtpInput };");
  const modal = scope.run(() => setup(...Object.values(context)));
  modal.phone.value = user.phone;
  modal.change(modal.phone.value, 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(modal.mode.value, "OTP");
  return { modal, calls, toasts, pauses, auth, user };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function advance(f, ms) {
  const task = f.pauses.shift();
  assert.ok(task, `missing ${ms}ms timer`);
  assert.equal(task.ms, ms);
  assert.equal(task.cancelled, false);
  task.callback();
  await flush();
}

async function finishAnimation(f, value) {
  for (let length = 2; length <= 6; length++) {
    await advance(f, 175);
    assert.equal(f.modal.code.value, value.slice(0, length));
    assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 0);
  }
  await advance(f, 400);
}

test("DEMO fills six cells at 175ms intervals, pauses 400ms and posts login once", async t => {
  let resolveLogin;
  const loginResponse = new Promise(resolve => { resolveLogin = resolve; });
  const f = await fixture(t, { ok: true, demoCode: "123456" }, { loginResponse });
  const submission = f.modal.submit();
  assert.equal(f.modal.otpStage.value, "generating");
  await flush();
  assert.equal(f.modal.otpStage.value, "showing");
  assert.equal(f.modal.demoCode.value, "123456");
  assert.equal(f.modal.code.value, "1");
  await f.modal.submit();
  assert.equal(f.calls.filter(call => call.path === "/auth/code").length, 1);
  await finishAnimation(f, "123456");
  assert.equal(f.modal.otpStage.value, "logging-in");
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 1);
  resolveLogin(f.user);
  await submission;
  const login = f.calls.filter(call => call.path === "/auth/login");
  assert.deepEqual(login[0].request.body, { phone: f.user.phone, code: "123456" });
  assert.equal(f.auth.user, f.user);
  assert.equal(f.modal.open.value, false);
  assert.deepEqual(f.toasts, [{ title: "\u0412\u044b \u0432\u043e\u0448\u043b\u0438" }]);
  assert.match(source, /v-for="index in 6"/);
  assert.match(source, /autocomplete="one-time-code"/);
  assert.match(source, /auth__otp-cell--filled/);
});

test("DEMO login failure stops automation and leaves the filled code for a deliberate retry", async t => {
  const f = await fixture(t, { ok: true, demoCode: "654321" }, { loginError: true });
  const submission = f.modal.submit();
  await flush();
  assert.equal(f.modal.code.value, "6");
  await finishAnimation(f, "654321");
  await submission;
  assert.equal(f.auth.user, null);
  assert.equal(f.modal.open.value, true);
  assert.equal(f.modal.loading.value, false);
  assert.equal(f.modal.code.value, "654321");
  assert.equal(f.modal.message.value, "Login failed");
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 1);
});

test("SMS WebOTP fills the same six cells before one login", async t => {
  const f = await fixture(t, { ok: true });
  const previousWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let resolveCredential;
  let signal;
  globalThis.window = { OTPCredential: class {} };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    credentials: { get: options => {
      signal = options.signal;
      return new Promise(resolve => { resolveCredential = resolve; });
    } },
  } });
  t.after(() => {
    globalThis.window = previousWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });
  await f.modal.submit();
  assert.equal(f.modal.codeSent.value, true);
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 0);
  resolveCredential({ code: "123456" });
  await flush();
  assert.equal(f.modal.code.value, "1");
  await finishAnimation(f, "123456");
  await flush();
  assert.equal(f.auth.user, f.user);
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 1);
  assert.equal(signal.aborted, true);
});

test("without WebOTP, SMS code can be entered manually; stale or malformed auto codes do not log in", async t => {
  const f = await fixture(t, { ok: true });
  await f.modal.submit();
  assert.equal(f.modal.codeSent.value, true);
  assert.equal(f.modal.open.value, true);
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 0);
  f.modal.code.value = "12";
  await f.modal.submit();
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 0);
  f.modal.code.value = "123456";
  await f.modal.submit();
  assert.equal(f.auth.user, f.user);
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 1);

  const invalid = await fixture(t, { ok: true, demoCode: "bad" });
  await invalid.modal.submit();
  assert.equal(invalid.calls.filter(call => call.path === "/auth/login").length, 0);
  assert.equal(invalid.modal.open.value, true);
});

test("WebOTP listens before SMS delivery and accepts a code arriving before the response", async t => {
  let resolveCode;
  const response = new Promise(resolve => { resolveCode = resolve; });
  const f = await fixture(t, response);
  const previousWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let resolveCredential;
  let signal;
  let listens = 0;
  globalThis.window = { OTPCredential: class {} };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    credentials: { get: options => {
      listens++;
      signal = options.signal;
      return new Promise(resolve => { resolveCredential = resolve; });
    } },
  } });
  t.after(() => {
    globalThis.window = previousWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });
  const submission = f.modal.submit();
  assert.equal(listens, 1);
  assert.equal(f.modal.codeSent.value, false);
  resolveCredential({ code: "123456" });
  await flush();
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 0);
  resolveCode({ ok: true });
  await submission;
  await flush();
  assert.equal(f.modal.code.value, "1");
  await finishAnimation(f, "123456");
  await flush();
  assert.equal(f.auth.user, f.user);
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 1);
  assert.equal(signal.aborted, true);
});

test("DEMO cancels the optional SMS listener and never waits for an SMS", async t => {
  const f = await fixture(t, { ok: true, demoCode: "123456" });
  const previousWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let signal;
  globalThis.window = { OTPCredential: class {} };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    credentials: { get: options => {
      signal = options.signal;
      return new Promise(() => {});
    } },
  } });
  t.after(() => {
    globalThis.window = previousWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });
  const submission = f.modal.submit();
  await flush();
  assert.equal(signal.aborted, true);
  await finishAnimation(f, "123456");
  await submission;
  assert.equal(f.auth.user, f.user);
});

test("a synchronous WebOTP API failure keeps SMS manual login available", async t => {
  const f = await fixture(t, { ok: true });
  const previousWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = { OTPCredential: class {} };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    credentials: { get: () => { throw new Error("Not supported"); } },
  } });
  t.after(() => {
    globalThis.window = previousWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });
  await f.modal.submit();
  assert.equal(f.modal.codeSent.value, true);
  f.modal.code.value = "123456";
  await f.modal.submit();
  assert.equal(f.auth.user, f.user);
});


test("closing the modal cancels the animated OTP before login", async t => {
  const f = await fixture(t, { ok: true, demoCode: "123456" });
  const submission = f.modal.submit();
  await flush();
  assert.equal(f.modal.code.value, "1");
  await advance(f, 175);
  assert.equal(f.modal.code.value, "12");
  const waiting = f.pauses[0];
  f.modal.open.value = false;
  await submission;
  assert.equal(waiting.cancelled, true);
  assert.equal(f.modal.code.value, "");
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 0);
});

test("reduced motion fills six cells immediately and still waits 400ms before login", async t => {
  const previousWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  t.after(() => { globalThis.window = previousWindow; });
  const f = await fixture(t, { ok: true, demoCode: "123456" });
  const submission = f.modal.submit();
  await flush();
  assert.equal(f.modal.code.value, "123456");
  assert.deepEqual(f.pauses.map(task => task.ms), [400]);
  await advance(f, 400);
  await submission;
  assert.equal(f.auth.user, f.user);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test("manual SMS input sanitizes pasted text into the same six cells", async t => {
  const f = await fixture(t, { ok: true });
  await f.modal.submit();
  const input = { value: "12x34y567" };
  f.modal.onOtpInput({ target: input });
  assert.equal(input.value, "123456");
  assert.equal(f.modal.code.value, "123456");
  await f.modal.submit();
  assert.equal(f.auth.user, f.user);
  assert.equal(f.calls.filter(call => call.path === "/auth/login").length, 1);
});
