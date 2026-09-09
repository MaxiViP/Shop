import test from "node:test";
import assert from "node:assert/strict";
import { staffTab, staffTabs, tabForStatus } from "../app/utils/staff-tabs.ts";
import {
  emptyNewOrders,
  newOrdersBadge,
  newOrdersLoader,
} from "../app/utils/new-orders.ts";

test("staff tabs are disjoint, including completed and canceled; confirmation selects assembly", () => {
  const statuses = [
    "NEW",
    "CONFIRMED",
    "ASSEMBLING",
    "READY",
    "DELIVERING",
    "COMPLETED",
    "CANCELED",
  ];
  for (const status of statuses)
    assert.equal(
      staffTabs.filter((tab) => tab.statuses.includes(status)).length,
      1,
    );
  assert.equal(tabForStatus("COMPLETED"), "finished");
  assert.equal(tabForStatus("CANCELED"), "canceled");
  assert.equal(tabForStatus("NEW"), "new");
  assert.equal(tabForStatus("CONFIRMED"), "assembly");
  assert.equal(tabForStatus("ASSEMBLING"), "assembly");
  assert.equal(staffTab("confirmed"), "assembly");
  assert.equal(staffTab("assembling"), "assembly");
  assert.equal(staffTab("invalid"), "new");
});
test("new-order badge is independent, zero hidden and >99 capped", () => {
  assert.deepEqual(emptyNewOrders(), { count: 0, latestOrderId: null });
  assert.equal(newOrdersBadge(0), "");
  assert.equal(newOrdersBadge(3), "3");
  assert.equal(newOrdersBadge(99), "99");
  assert.equal(newOrdersBadge(100), "99+");
});
test("background refresh keeps count; immediate invalidation after confirm is not lost during a pending poll", async () => {
  let complete;
  let calls = 0;
  let current = { count: 3, latestOrderId: 10 };
  const loader = newOrdersLoader(
    () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    (value) => {
      current = value;
    },
  );
  const pending = loader.refresh();
  assert.equal(current.count, 3);
  await loader.refresh(); // confirmation refresh queued while the previous request is pending
  complete({ count: 3, latestOrderId: 10 });
  await pending;
  assert.equal(calls, 2);
  complete({ count: 2, latestOrderId: 9 });
  await Promise.resolve();
  assert.equal(current.count, 2);
  loader.dispose();
});
test("failure keeps last badge and disposal prevents stale response updates", async () => {
  let count = 3;
  const failed = newOrdersLoader(
    async () => {
      throw new Error("offline");
    },
    (value) => {
      count = value.count;
    },
  );
  await failed.refresh();
  assert.equal(count, 3);
  let complete;
  const loader = newOrdersLoader(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    (value) => {
      count = value.count;
    },
  );
  const pending = loader.refresh();
  loader.dispose();
  complete({ count: 99, latestOrderId: 2 });
  await pending;
  assert.equal(count, 3);
});
