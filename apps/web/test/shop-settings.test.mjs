import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryEligibility,
  extraLimitError,
} from "../app/utils/shop-settings.ts";
import { rublesToKopecks } from "../app/utils/money.ts";
const settings = {
  minDeliverySubtotal: 300000,
  deliveryEnabled: true,
  pickupEnabled: true,
};
test("remaining, progress clamp, minimum zero and availability", () => {
  assert.deepEqual(deliveryEligibility(243000, settings), {
    remaining: 57000,
    progress: 81,
    delivery: false,
    pickup: true,
  });
  assert.equal(deliveryEligibility(400000, settings).progress, 100);
  assert.equal(deliveryEligibility(-1, settings).progress, 0);
  assert.equal(
    deliveryEligibility(0, { ...settings, minDeliverySubtotal: 0 }).delivery,
    true,
  );
  assert.equal(
    deliveryEligibility(400000, { ...settings, deliveryEnabled: false })
      .delivery,
    false,
  );
  assert.equal(
    deliveryEligibility(400000, { ...settings, pickupEnabled: false }).pickup,
    false,
  );
  assert.equal(deliveryEligibility(300000, settings).delivery, true);
});
test("admin rubles are exact, zero only when opted in", () => {
  assert.equal(rublesToKopecks("3000,50", true), 300050);
  assert.equal(rublesToKopecks("0", true), 0);
  assert.equal(rublesToKopecks("0"), null);
});
test("extra preview uses limits and permits reduction after policy lowered", () => {
  const limits = {
    maxOrderExtraUnitPrice: 500000,
    maxOrderExtrasTotal: 1000000,
  };
  assert.equal(extraLimitError(500000, 500000, 500000, undefined, limits), "");
  assert.ok(extraLimitError(500001, 500001, 0, undefined, limits));
  assert.ok(extraLimitError(1, 1, 1000000, undefined, limits));
  assert.equal(
    extraLimitError(
      600000,
      1200000,
      1400000,
      { unitPrice: 700000, amount: 1400000 },
      limits,
    ),
    "",
  );
});
