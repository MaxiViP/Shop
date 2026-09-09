import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { orderWaitMinutes } from "../app/utils/order-wait.ts";
import { approvedWeight } from "../app/utils/assembly.ts";

test("timeout uses whole elapsed minutes, handles future timestamps and exact boundary", () => {
  const created = "2026-09-09T08:00:00Z";
  assert.equal(orderWaitMinutes(created, Date.parse(created) + 599999), 9);
  assert.equal(orderWaitMinutes(created, Date.parse(created) + 600000), 10);
  assert.equal(orderWaitMinutes(created, Date.parse(created) - 1000), 0);
  assert.equal(orderWaitMinutes("invalid", 0), 0);
});
test("staff uses exact approved weight, not a blanket tolerance override", () => {
  const issue = {
    status: "RESOLVED",
    resolution: "ACCEPT_ACTUAL",
    actualQty: 2000,
    approvedActualQty: 2000,
  };
  assert.equal(approvedWeight(issue, 2000), true);
  assert.equal(approvedWeight(issue, 2100), false);
  assert.equal(
    approvedWeight({ ...issue, approvedActualQty: null }, 2000),
    false,
  );
});
test("chat uses text interpolation, never executes message HTML", async () => {
  const source = await readFile(
    new URL("../app/components/order/Chat.vue", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("{{ entry.text }}"));
  assert.ok(!source.includes("v-html"));
});
