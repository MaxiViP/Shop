import assert from "node:assert/strict";
import test from "node:test";
import { ordersAction } from "../app/utils/orders-action.ts";
import { newOrdersBadge, newOrdersLoader } from "../app/utils/new-orders.ts";

test("customer unread belongs to My Orders, including read reset and badge cap", () => {
  for (const [unread, badge] of [
    [0, ""],
    [3, "3"],
    [0, ""],
    [100, "99+"],
  ]) {
    const action = ordersAction(false, 20, unread, 123);
    assert.equal(action.name, "Мои заказы");
    assert.equal(action.to, "/orders");
    assert.equal(action.newOrdersCount, 0);
    assert.equal(newOrdersBadge(action.newOrdersCount), "");
    assert.equal(action.unreadMessagesCount, unread);
    assert.equal(newOrdersBadge(action.unreadMessagesCount), badge);
  }
});

test("staff shows independent green/new and blue/unread badges with an accessible breakdown", () => {
  for (const [fresh, unread, green, blue, label] of [
    [2, 3, "2", "3", "Заказы: новых 2, непрочитанных сообщений 3"],
    [0, 3, "", "3", "Заказы: непрочитанных сообщений 3"],
    [2, 0, "2", "", "Заказы: новых 2"],
    [0, 0, "", "", "Заказы"],
    [100, 101, "99+", "99+", "Заказы: новых 100, непрочитанных сообщений 101"],
  ]) {
    const action = ordersAction(true, fresh, unread, 123);
    assert.equal(action.newOrdersCount, fresh);
    assert.equal(action.unreadMessagesCount, unread);
    assert.equal(action.label, label);
    assert.equal(newOrdersBadge(action.newOrdersCount), green);
    assert.equal(newOrdersBadge(action.unreadMessagesCount), blue);
  }
});

test("staff click prioritizes new orders, then latest unread, then list", () => {
  assert.equal(ordersAction(true, 2, 3, 123).to, "/staff/orders?tab=new");
  assert.equal(ordersAction(true, 0, 3, 123).to, "/staff/orders/123");
  assert.equal(ordersAction(true, 0, 3, null).to, "/staff/orders");
  assert.equal(ordersAction(true, 0, 0, 123).to, "/staff/orders");
});

test("immediate refresh after confirm reduces only new orders; read reduces only unread", async () => {
  let serverCount = 2;
  let newCount = 0;
  const loader = newOrdersLoader(
    async () => ({ count: serverCount, latestOrderId: 123 }),
    (summary) => {
      newCount = summary.count;
    },
  );
  await loader.refresh();
  const counts = (unread) => {
    const action = ordersAction(true, newCount, unread, 123);
    return [action.newOrdersCount, action.unreadMessagesCount];
  };
  assert.deepEqual(counts(3), [2, 3]);
  serverCount--;
  await loader.refresh();
  assert.deepEqual(counts(3), [1, 3]);
  assert.deepEqual(counts(1), [1, 1]);
  loader.dispose();
});
