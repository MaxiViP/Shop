import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computed, reactive, ref } from "vue";

const component = await readFile(new URL("../app/components/auth/OrderPhones.vue", import.meta.url), "utf8");
const profile = await readFile(new URL("../app/pages/profile.vue", import.meta.url), "utf8");
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile("OrderPhones.ts", script, ts.ScriptTarget.Latest, true);
let executable = script;
for (const statement of [...parsed.statements].reverse())
  if (ts.isImportDeclaration(statement))
    executable = executable.slice(0, statement.getStart()) + executable.slice(statement.end);
executable = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("profile phone editor uses owner API for add/edit/delete/primary without touching auth fields", async () => {
  const props = reactive({ snapshot: {
    phones: [{ id: null, phone: "+79990000001", source: "ACCOUNT" }],
    primaryPhone: "+79990000001",
    manualCount: 0,
  } });
  const calls = [];
  const state = { nextId: 1 };
  const api = async (path, options) => {
    calls.push({ path, ...options });
    const value = JSON.parse(JSON.stringify(props.snapshot));
    if (options.method === "POST") {
      value.phones.push({ id: state.nextId++, phone: options.body.phone, source: "MANUAL" });
    } else if (path === "/order-phones/primary") {
      value.primaryPhone = options.body.phone;
    } else {
      const id = Number(path.split("/").at(-1));
      if (options.method === "PATCH")
        value.phones.find(item => item.id === id).phone = options.body.phone;
      else value.phones = value.phones.filter(item => item.id !== id);
    }
    value.manualCount = value.phones.filter(item => item.source === "MANUAL").length;
    return value;
  };
  const context = {
    computed, ref,
    defineProps: () => props,
    defineEmits: () => (_event, value) => { props.snapshot = value; },
    useApiClient: () => api,
  };
  const setup = new AsyncFunction(...Object.keys(context),
    executable + "\nreturn { draft, editingId, manualCount, save, startEdit, remove, setPrimary, sourceLabel, inputError };");
  const value = await setup(...Object.values(context));
  assert.match(profile, /<AuthOrderPhones/);
  assert.match(profile, /:preferred-phone="orderPhoneData\?\.primaryPhone"/);
  assert.equal(value.sourceLabel("ACCOUNT"), "Телефон аккаунта");
  assert.equal(value.sourceLabel("TELEGRAM"), "Подтверждённый Telegram");
  assert.match(value.sourceLabel("MANUAL"), /не подтверждён/);

  value.draft.value = "+7 999";
  await value.save();
  assert.ok(value.inputError.value);
  assert.equal(calls.length, 0);

  value.draft.value = "+7 999 000 00 05";
  await value.save();
  assert.equal(calls[0].path, "/order-phones");
  assert.equal(calls[0].method, "POST");
  assert.equal(value.manualCount.value, 1);
  const item = props.snapshot.phones[1];
  value.startEdit(item);
  value.draft.value = "+7 999 000 00 06";
  await value.save();
  assert.equal(calls[1].path, `/order-phones/${item.id}`);
  assert.equal(calls[1].method, "PATCH");
  await value.setPrimary("+79990000006");
  assert.equal(props.snapshot.primaryPhone, "+79990000006");
  await value.remove(props.snapshot.phones[1]);
  assert.equal(calls.at(-1).method, "DELETE");
  assert.deepEqual(props.snapshot.phones, [{ id: null, phone: "+79990000001", source: "ACCOUNT" }]);
  assert.equal(value.manualCount.value, 0);
  assert.ok(calls.every(call => call.path.startsWith("/order-phones")));
  assert.doesNotMatch(component, /User\.phone\s*=|TelegramIdentity|verifiedAt\s*=/);
});

test("profile editor advertises five-number limit and neutral phone placeholder", () => {
  assert.match(component, /manualCount < 5/);
  assert.match(component, /Добавлено пять дополнительных номеров/);
  assert.match(component, /placeholder="\+7 \(___\) ___-__-__"/);
});
