import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parse, compileScript } from "vue/compiler-sfc";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import ts from "typescript";

const source = await readFile(new URL("../app/components/auth/ProfileCard.vue", import.meta.url), "utf8");
const { descriptor } = parse(source, { filename: "ProfileCard.vue" });
const compiled = compileScript(descriptor, { id: "profile-test", inlineTemplate: true });
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("require", "exports", "module", code)(createRequire(import.meta.url), module.exports, module);
const ProfileCard = module.exports.default;
const telegram = {
  connected: true, username: "max", firstName: "Максим", lastName: null,
  photoUrl: "https://example.test/avatar.webp",
  phoneNumber: "+79991234567", phoneVerified: true,
};
const user = { id: 1, phone: null, name: null, role: "USER", verifiedAt: null, telegram };

async function render(changes = {}) {
  const app = createSSRApp(ProfileCard, { user: { ...user, ...changes } });
  // Render actual profile template with minimal UI primitives; no network.
  app.component("UAvatar", defineComponent({
    props: ["src", "alt", "text", "icon"],
    setup: props => () => props.src
      ? h("img", { src: props.src, alt: props.alt })
      : h("span", { "data-avatar-fallback": true }, props.text),
  }));
  app.component("UBadge", defineComponent({ setup: (_, { slots }) => () => h("span", slots.default?.()) }));
  return renderToString(app);
}

test("Telegram profile renders avatar, username and verified metadata without a fake order phone", async () => {
  const html = await render();
  for (const value of ["Максим", "@max", "Telegram подключен", "Телефон Telegram", "+79991234567", "Подтверждено Telegram", "Телефон для заказов не указан"])
    assert.ok(html.includes(value), value);
  assert.match(html, /src="https:\/\/example\.test\/avatar\.webp"/);
  assert.ok(!html.includes("telegramUserId"));
});

test("phone-only user with telegram=null renders compatible account details", async () => {
  const html = await render({ telegram: null, phone: "+79997654321" });
  assert.ok(html.includes("По телефону"));
  assert.ok(html.includes("+79997654321"));
  assert.ok(!html.includes("Telegram подключен"));
  assert.ok(!html.includes("null"));
  assert.ok(!html.includes("undefined"));
});

test("absent optional metadata has readable avatar and phone fallbacks", async () => {
  const html = await render({ telegram: { ...telegram, username: null, photoUrl: null, phoneNumber: null, phoneVerified: false } });
  assert.match(html, /data-avatar-fallback="true"/);
  assert.ok(html.includes("Номер Telegram не предоставлен"));
  assert.ok(!html.includes("@"));
  assert.ok(!html.includes("Подтверждено Telegram"));
  assert.ok(!html.includes("null"));
});

test("unverified Telegram phone never gets the verified badge and remains separate from User.phone", async () => {
  const html = await render({ phone: "+79997654321", telegram: { ...telegram, phoneVerified: false } });
  assert.ok(html.includes("+79997654321"));
  assert.ok(html.includes("+79991234567"));
  assert.ok(!html.includes("Подтверждено Telegram"));
});

test("user-chosen name takes precedence and all profile text is escaped", async () => {
  const html = await render({ name: "<script>chosen</script>" });
  assert.ok(html.includes("&lt;script&gt;chosen&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("profile page retains addresses, orders and logout around the account card", async () => {
  const page = await readFile(new URL("../app/pages/profile.vue", import.meta.url), "utf8");
  for (const content of ["<AuthProfileCard", "<AddressCard", "<OrderList", "/auth/logout"])
    assert.ok(page.includes(content));
  assert.ok(page.indexOf("<AuthProfileCard") < page.indexOf("<AddressCard"));
});
