import assert from "node:assert/strict";
import test from "node:test";
import { orderProgress } from "../app/utils/order-progress.ts";

test("each active status has one current step and only previous steps completed", () => {
  for (const type of ["DELIVERY", "PICKUP"]) {
    const flow = orderProgress("NEW", type).steps;
    for (const [index, step] of flow.entries()) {
      if (step.status === "COMPLETED") continue;
      const result = orderProgress(step.status, type);
      assert.equal(result.steps.filter((s) => s.state === "current").length, 1);
      assert.equal(result.steps[index].status, step.status);
      assert.equal(result.steps[index].state, "current");
      assert.ok(
        result.steps.slice(0, index).every((s) => s.state === "completed"),
      );
      assert.ok(
        result.steps.slice(index + 1).every((s) => s.state === "future"),
      );
    }
  }
});

test("pickup excludes delivery and has a pickup-ready label", () => {
  assert.ok(
    orderProgress("READY", "DELIVERY").steps.some(
      (s) => s.status === "DELIVERING",
    ),
  );
  const pickup = orderProgress("READY", "PICKUP").steps;
  assert.ok(!pickup.some((s) => s.status === "DELIVERING"));
  assert.equal(
    pickup.find((s) => s.state === "current").label,
    "Готов к выдаче",
  );
});

test("completed means every relevant step is completed, canceled is not a step", () => {
  for (const type of ["DELIVERY", "PICKUP"]) {
    assert.ok(
      orderProgress("COMPLETED", type).steps.every(
        (s) => s.state === "completed",
      ),
    );
    assert.deepEqual(orderProgress("CANCELED", type), {
      canceled: true,
      unknown: false,
      steps: [],
    });
  }
});

test("unexpected server status never claims a current or completed step", () => {
  assert.deepEqual(orderProgress("UNKNOWN", "DELIVERY"), {
    canceled: false,
    unknown: true,
    steps: [],
  });
  assert.equal(orderProgress("DELIVERING", "PICKUP").unknown, true);
});
