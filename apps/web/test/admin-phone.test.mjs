import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parse, compileTemplate } from "vue/compiler-sfc";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import ts from "typescript";

const source = await readFile(new URL("../app/pages/admin/users.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const compiled = compileTemplate({ source: descriptor.template.content, filename: "users.vue", id: "admin-phone-test" });
assert.deepEqual(compiled.errors, []);
const code = ts.transpileModule(compiled.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("require", "exports", "module", code)(createRequire(import.meta.url), module.exports, module);

async function render(changes = {}) {
  const user = { id: 10, name: "Test", phone: null, verifiedAt: null, role: "USER", ownedPoints: [],
    telegramIdentity: { phoneNumber: "+79990000010", phoneVerified: true },
    orders: 0, spent: 0, unknownTotals: 0, createdAt: "2026-11-03", updatedAt: "2026-11-03", ...changes };
  const app = createSSRApp({ render: module.exports.render, setup: () => ({
    data: { items: [user], total: 1, pages: 1 }, query: { page: 1 }, search: "", role: "all",
    pending: false, error: null, permissions: null, roles: { USER: "Пользователь" },
    date: value => value || "—", money: value => String(value), detailOpen: false, detailId: null,
    confirm: false, selected: null, pointsOpen: false, ownerUser: null, pointOptions: [],
    pointIds: [], roleOptions: [], busy: false, nextRole: "USER", adminPassword: "",
    apply() {}, editRole() {}, editPoints() {}, savePoints() {}, saveRole() {}, togglePoint() {},
  }) });
  for (const name of ["UFormField", "UInput", "USelect", "UButton", "UBadge", "UCheckbox", "UAlert"])
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h("span", slots.default?.()) }));
  app.component("UModal", defineComponent({ setup: () => () => null }));
  app.component("AdminUserDetail", defineComponent({ setup: () => () => null }));
  return renderToString(app);
}

test("admin renders legacy Telegram phone with source and without primary verification", async () => {
  const html = await render();
  assert.ok(html.includes("+79990000010"));
  assert.ok(html.includes("Номер из Telegram · основной номер не подтверждён"));
});

test("admin gives the primary phone precedence over Telegram metadata", async () => {
  const html = await render({ phone: "+79990000011", verifiedAt: "2026-11-03" });
  assert.ok(html.includes("+79990000011"));
  assert.ok(!html.includes("+79990000010"));
  assert.ok(!html.includes("основной номер не подтверждён"));
});

test("admin never displays unverified Telegram phone as the fallback", async () => {
  const html = await render({ telegramIdentity: { phoneNumber: "+79990000010", phoneVerified: false } });
  assert.ok(!html.includes("+79990000010"));
});
