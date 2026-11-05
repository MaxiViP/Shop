import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startWeb } from "./browser.mjs";

const artifacts = resolve(
  process.env.EVENT_SMOKE_ARTIFACT_DIR ?? "work/event-center/browser",
);
await mkdir(artifacts, { recursive: true });
const actors = [
  { id: 1, name: "Владелец" },
  { id: 2, name: "Анна" },
  { id: 3, name: "Михаил" },
];
let version = 10;
const base = {
  requestId: "11111111-1111-4111-8111-111111111111",
  actorId: 2,
  actorName: actors[1].name,
  actorRole: "ADMIN",
  source: "WEB",
  category: "ADMINISTRATORS",
  title: "Изменения магазина",
  entity: "Product",
  entityId: "24",
  operation: "UPDATE",
  beforeValue: { price: 18000 },
  afterValue: { price: 19500 },
  orderId: null,
  productId: 24,
  createdAt: "2026-11-03T08:15:00Z",
  ownerOnly: false,
};
let events = [
  { ...base, id: 10 },
  {
    ...base,
    id: 9,
    requestId: "22222222-2222-4222-8222-222222222222",
    actorId: 3,
    actorName: actors[2].name,
    actorRole: "SELLER",
    source: "TELEGRAM",
    category: "RECEIPTS",
    title: "Состав и сумма заказа",
    entity: "OrderItem",
    entityId: "41",
    orderId: 1000,
    beforeValue: { actualQty: 1000, actualTotal: 18000 },
    afterValue: { actualQty: 1150, actualTotal: 20700 },
  },
  {
    ...base,
    id: 8,
    requestId: "33333333-3333-4333-8333-333333333333",
    actorId: null,
    actorName: "Система",
    actorRole: "SYSTEM",
    source: "SYSTEM",
    category: "SYSTEM",
    title: "Проблема доставки уведомления",
    entity: "OrderNotification",
    orderId: 1000,
    productId: null,
    beforeValue: { status: "SENDING" },
    afterValue: { status: "FAILED" },
  },
  {
    ...base,
    id: 7,
    requestId: "44444444-4444-4444-8444-444444444444",
    actorId: 1,
    actorName: actors[0].name,
    title: "Права и закрытые изменения",
    entity: "User",
    entityId: "2",
    productId: null,
    ownerOnly: true,
    beforeValue: { role: "USER" },
    afterValue: { role: "ADMIN" },
  },
  {
    ...base,
    id: 6,
    requestId: "55555555-5555-4555-8555-555555555555",
    actorId: null,
    actorName: "Покупатель",
    actorRole: "CUSTOMER",
    source: "WEB",
    category: "ORDERS",
    title: "Заказ создан",
    entity: "Order",
    entityId: "1000",
    orderId: 1000,
    productId: null,
    operation: "INSERT",
    beforeValue: null,
    afterValue: { status: "NEW", total: 18000 },
  },
];
const initialEvents = structuredClone(events);
const streams = new Set();
let connections = 0;
function matches(event, url, primary) {
  return (
    (primary || !event.ownerOnly) &&
    (!url.searchParams.get("category") ||
      event.category === url.searchParams.get("category")) &&
    (!url.searchParams.get("actorId") ||
      event.actorId === Number(url.searchParams.get("actorId"))) &&
    (!url.searchParams.get("orderId") ||
      event.orderId === Number(url.searchParams.get("orderId"))) &&
    (!url.searchParams.get("q") ||
      JSON.stringify(event)
        .toLowerCase()
        .includes(url.searchParams.get("q").toLowerCase()))
  );
}
const api = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "content-type,last-event-id");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  const primary = req.headers.cookie?.includes("sid=owner") ?? false;
  const logged =
    primary || (req.headers.cookie?.includes("sid=delegate") ?? false);
  const user = {
    id: primary ? 1 : 2,
    name: primary ? actors[0].name : actors[1].name,
    phone: primary ? "+79990000001" : "+79990000002",
    role: "ADMIN",
    ownedPoints: [],
    telegram: null,
  };
  if (url.pathname === "/api/admin/events/stream") {
    if (!logged) {
      res.writeHead(403);
      res.end();
      return;
    }
    connections++;
    res.setHeader("Content-Type", "text/event-stream");
    res.write("retry: 300\n\n");
    const last = Number(
      String(
        req.headers["last-event-id"] ?? url.searchParams.get("cursor") ?? "0",
      ).replace("v", ""),
    );
    const send = (count) =>
      res.write(
        `id: v${version}\nevent: sync\ndata: ${JSON.stringify({ count, cursor: "v" + version })}\n\n`,
      );
    const item = { res, url, primary, send };
    streams.add(item);
    res.on("close", () => streams.delete(item));
    send(events.filter((e) => e.id > last && matches(e, url, primary)).length);
    return;
  }
  res.setHeader("Content-Type", "application/json");
  let body = {};
  if (url.pathname === "/api/auth/admin/login") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (input.password !== "Fixture-secure-password-2026") {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: "Неверные данные для входа" }));
      return;
    }
    const owner = input.phone.replace(/\D/g, "").endsWith("00001");
    res.setHeader(
      "Set-Cookie",
      `sid=${owner ? "owner" : "delegate"}; HttpOnly; SameSite=Lax; Path=/`,
    );
    body = { ...user, id: owner ? 1 : 2, role: "ADMIN" };
  } else if (url.pathname === "/api/auth/me") body = logged ? user : null;
  else if (url.pathname.startsWith("/api/favorites")) body = { items: [] };
  else if (url.pathname === "/api/admin/users/permissions")
    body = { primaryAdmin: primary };
  else if (url.pathname === "/api/admin/events") {
    const rows = events.filter(
      (e) =>
        matches(e, url, primary) &&
        (!url.searchParams.get("before") ||
          e.id < Number(url.searchParams.get("before"))),
    );
    body = {
      items: rows.slice(0, 4),
      total: rows.length,
      next: rows.length > 4 ? rows[3].id : null,
      primary,
      actors,
      cursor: "v" + version,
    };
  } else if (url.pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/");
    body = { ok: true };
  } else if (url.pathname.includes("products"))
    body = { items: [], total: 0, pages: 1 };
  else if (url.pathname.includes("orders")) body = { items: [], total: 0 };
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
let browser, web;
try {
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CATALOG_BROWSER_PATH ??
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  for (const width of [390, 1280]) {
    await expect.poll(() => streams.size).toBe(0);
    events = structuredClone(initialEvents);
    version = 10;
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(web.base + "/admin/events");
    await page.waitForFunction(
      () =>
        document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties
          .$nuxt?.isHydrating === false,
    );
    await expect(page).toHaveURL(/\/admin\/login$/);
    await page.locator("input[type=tel]").fill("+79990000001");
    await page.locator("input[type=password]").fill("wrong");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(
      page.getByText("Неверные данные для входа", { exact: true }),
    ).toBeVisible();
    await page
      .locator("input[type=password]")
      .fill("Fixture-secure-password-2026");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/products$/);
    await page
      .getByRole("link", { name: "Центр событий", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Центр событий", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Обновляется онлайн", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Только владелец", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("11:15", { exact: true }).first(),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "horizontal overflow",
    );
    await page.screenshot({
      path: join(artifacts, `events-owner-${width}.png`),
      fullPage: true,
    });
    if (width < 900)
      await page
        .getByRole("button", { name: "Показать фильтры", exact: true })
        .click();
    await page.getByLabel("Номер заказа", { exact: true }).fill("1000");
    await page
      .getByRole("button", { name: "Применить фильтры", exact: true })
      .click();
    await expect(page.locator(".events__entry")).toHaveCount(3);
    await page.getByRole("button", { name: "По заказам", exact: true }).click();
    await expect(page.locator(".events__message")).toHaveCount(1);
    await expect(page.locator(".events__entry-author").first()).toContainText("3 ноября 2026");
    await page.getByRole("button", { name: "Сбросить", exact: true }).click();
    await expect(page.locator(".events__entry")).toHaveCount(4);
    await expect.poll(() => streams.size).toBe(1);
    const add = (title) => {
      const event = { ...base, id: ++version, title };
      events.unshift(event);
      for (const stream of streams)
        stream.send(matches(event, stream.url, stream.primary) ? 1 : 0);
    };
    add("Новое изменение онлайн");
    await expect(
      page.getByRole("heading", {
        name: "Новое изменение онлайн",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /новых событий/ }),
    ).toBeVisible();
    await expect.poll(() => streams.size).toBe(1);
    const before = connections;
    for (const item of streams) item.res.end();
    events.unshift({
      ...base,
      id: ++version,
      title: "Восстановлено после переподключения",
    });
    await expect(
      page.getByRole("heading", {
        name: "Восстановлено после переподключения",
        exact: true,
      }),
    ).toBeVisible();
    assert.ok(connections > before, "SSE reconnect");
    assert.equal(await page.locator(".events__entry").count(), 4);
    assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    }),
    page = await context.newPage();
  await context.addCookies([
    {
      name: "sid",
      value: "delegate",
      url: web.base,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(web.base + "/admin/events");
  await page.waitForFunction(
    () =>
      document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties
        .$nuxt?.isHydrating === false,
  );
  await expect(
    page.getByRole("heading", { name: "Центр событий", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Только владелец", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", {
      name: "Доставка уведомлений владельцу",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Закрытые события доступны владельцу.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: join(artifacts, "events-delegate-1280.png"),
    fullPage: true,
  });
  await context.close();
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        passed: true,
        widths: [390, 1280],
        login: true,
        filters: true,
        live: true,
        reconnect: true,
        delegated: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, artifacts }));
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      await page
        .screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
        .catch(() => {});
  throw error;
} finally {
  for (const item of streams) item.res.end();
  await browser?.close();
  await web?.close();
  await new Promise((resolve) => api.close(resolve));
}
