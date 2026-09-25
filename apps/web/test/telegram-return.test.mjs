import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { telegramReturnTo } from "../app/utils/telegram-return.ts";
import { customerBotUrl } from "../app/utils/customer-bot-url.ts";

const order = "/order/11111111-1111-4111-8111-111111111111";
test("only exact local CUSTOMER paths survive returnTo validation", () => {
  for (const target of ["/", "/catalog", "/catalog/vegetables", "/product/apple",
    "/product/green-grapes", order, "/orders", "/profile", "/cart",
    "/favorites", "/delivery"])
    assert.equal(telegramReturnTo(target), target);
  for (const target of [null, ["https://evil.example"], "https://evil.example",
    "//evil.example", "javascript:alert(1)", "/\\evil", "/%2F%2Fevil",
    "/product/../admin", "/product/a%2Fb", "/product/a?next=//evil.example",
    "/order/not-a-uuid", "/admin", "/staff", "/api", "/telegram",
    "/catalog/a%ZZ", "/profile\n", "/orders#fragment"])
    assert.equal(telegramReturnTo(target), "/catalog");
});

test("customer bot URL validator rejects unsafe, missing and seller destinations", () => {
  const url = "https://t.me/KorzinaMarketBot";
  assert.equal(customerBotUrl(url), url);
  for (const value of ["", undefined, "http://t.me/customer_bot",
    "https://evil.example/customer_bot", "https://t.me/korzinamarket_seller_bot",
    "https://t.me/customer_bot?token=secret"])
    assert.equal(customerBotUrl(value), null);
});

test("desktop icon and burger item share a safe CUSTOMER-only external URL", async () => {
  const header = await readFile(new URL("../app/components/app/Header.vue", import.meta.url), "utf8");
  assert.match(header, /<nav class="header__nav"[\s\S]*?<a\s+v-if="customerTelegramUrl"[\s\S]*?class="header__telegram"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?aria-label="Покупать в Telegram"[\s\S]*?title="Покупать в Telegram"[\s\S]*?i-lucide-send/);
  assert.match(header, /class="header__telegram"[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(header, /v-if="customerTelegramUrl"[\s\S]*?:href="customerTelegramUrl"[\s\S]*?class="mobile-nav__link"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?Покупать в Telegram/);
  assert.match(header, /customerBotUrl\(useRuntimeConfig\(\)\.public\.telegramCustomerBotUrl\)/);
  assert.doesNotMatch(header, /korzinamarket_seller_bot/);
});
