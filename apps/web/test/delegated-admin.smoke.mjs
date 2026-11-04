import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWeb } from "./browser.mjs";
import { chromium, expect } from "@playwright/test";

const artifacts =
  process.env.ADMIN_SMOKE_ARTIFACT_DIR ??
  (await mkdtemp(join(tmpdir(), "korzina-admin-access-")));
await mkdir(artifacts, { recursive: true });
let primary = true;
const mutations = [];
const users = [
  {
    id: 1,
    name: "Основной администратор",
    phone: "+79990000001",
    role: "ADMIN",
    protected: true,
  },
  {
    id: 2,
    name: "Назначенный администратор",
    phone: "+79990000002",
    role: "ADMIN",
    protected: false,
  },
  {
    id: 3,
    name: "Новый пользователь",
    phone: "+79990000003",
    role: "USER",
    protected: false,
  },
].map((x) => ({
  ...x,
  ownedPoints: [],
  verifiedAt: "2026-11-03T08:00:00Z",
  createdAt: "2026-11-03T08:00:00Z",
  updatedAt: "2026-11-03T08:00:00Z",
  orders: 0,
  spent: 0,
  unknownTotals: 0,
}));
const event = {
  id: 5,
  actorName: "Назначенный администратор",
  source: "TELEGRAM",
  entity: "Product",
  entityId: "24",
  operation: "UPDATE",
  status: "UNKNOWN",
  createdAt: "2026-11-03T08:00:00Z",
  beforeValue: { name: "Яблоки", price: 10000 },
  afterValue: { name: "Яблоки с рынка", price: 12000 },
};
const api = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("Content-Type", "application/json");
  if (
    req.headers.origin &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin)
  ) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : null;
  let body = {};
  if (url.pathname === "/api/auth/me")
    body = { ...users[primary ? 0 : 1], telegram: null };
  else if (url.pathname.startsWith("/api/favorites")) body = { items: [] };
  else if (url.pathname === "/api/admin/users/permissions")
    body = { primaryAdmin: primary };
  else if (url.pathname === "/api/admin/users")
    body = { items: users, total: 3, page: 1, pages: 1 };
  else if (url.pathname === "/api/admin/market-map/points") body = [];
  else if (url.pathname === "/api/admin/activity")
    body = { items: [event], total: 1, page: 1, pages: 1, deliveryReady: true };
  else if (url.pathname === "/api/admin/activity/test")
    body = { status: "sent" };
  else if (url.pathname.endsWith("/retry")) {
    event.status = "PENDING";
    body = { ok: true };
  } else if (url.pathname.endsWith("/role")) {
    mutations.push(input);
    users[2].role = input.role;
    body = users[2];
  } else if (url.pathname.includes("/orders")) body = { items: [], total: 0 };
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
let web, browser;
try {
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await chromium.launch({
    executablePath:
      process.env.CATALOG_BROWSER_PATH ??
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  for (const width of [320, 390, 768, 1280]) {
    primary = true;
    users[2].role = "USER";
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(web.base + "/admin/users");
    await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false);
    await expect(
      page
        .getByRole("navigation", { name: "Админка" })
        .getByRole("link", { name: "Журнал администраторов" }),
    ).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "Новый пользователь" });
    await row
      .getByRole("button", { name: "Права доступа", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").click();
    // Playwright waits for the portalled option to become stable and receive
    // pointer events. Raw DOM dispatch/CDP coordinates raced the modal transition.
    await page
      .getByRole("option", { name: "Администратор", exact: true })
      .click();
    const password = dialog.locator("input[type=password]");
    await expect(password).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Сохранить права", exact: true }),
    ).toBeDisabled();
    await password.fill("Fixture-secure-password-2026");
    await expect(
      dialog.getByRole("button", { name: "Сохранить права", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: join(artifacts, `grant-admin-${width}.png`),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Сохранить права", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    assert.deepEqual(mutations.at(-1), {
      role: "ADMIN",
      password: "Fixture-secure-password-2026",
    });
    await page.goto(web.base + "/admin/activity");
    await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false);
    await expect(
      page.getByText("Доставка не подтверждена", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: join(artifacts, `admin-journal-${width}.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
  primary = false;
  users[2].role = "USER";
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  await page.goto(web.base + "/admin/users");
  await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false);
  await expect(
    page.getByRole("link", { name: "Журнал администраторов" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Назначенный администратор" })
      .getByRole("button", { name: "Права доступа", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Права доступа", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Точки владельца", exact: true }),
  ).toHaveCount(0);
  console.log(
    JSON.stringify({
      passed: true,
      widths: [320, 390, 768, 1280],
      primaryGrant: true,
      primaryJournal: true,
      delegatedRestrictions: true,
      artifacts,
    }),
  );
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      await page
        .screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
        .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await new Promise((resolve) => api.close(resolve));
}
