import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblyDrafts } from "../app/utils/assembly-drafts.ts";
import {
  percentToBps,
  bpsPercent,
  weightRange,
  lineAmount,
  outsideTolerance,
} from "../app/utils/assembly.ts";
test("weight warning uses inclusive per-item tolerance, not total price", () => {
  assert.equal(outsideTolerance("GRAM", 1000, 1100, 1000), false);
  assert.equal(outsideTolerance("GRAM", 1000, 1101, 1000), true);
  assert.equal(outsideTolerance("GRAM", 1000, 2000, 1000), true);
  assert.equal(outsideTolerance("PACK", 1, 2, 1000), false);
});
test("refresh of saved A preserves dirty B; explicit reset uses server value", () => {
  const drafts = assemblyDrafts();
  const rows = [
    { id: 1, qty: 1000, actualQty: null },
    { id: 2, qty: 500, actualQty: null },
  ];
  drafts.sync(rows);
  drafts.values[1] = 1037;
  drafts.values[2] = 486;
  drafts.sync([{ ...rows[0], actualQty: 1037 }, rows[1]]);
  drafts.reset(1);
  assert.equal(drafts.values[1], 1037);
  assert.equal(drafts.values[2], 486);
  drafts.reset(2);
  assert.equal(drafts.values[2], 500);
  drafts.sync([{ ...rows[0], qty: 1100, actualQty: null }]);
  assert.equal(drafts.values[1], 1100);
  assert.equal(drafts.values[2], undefined);
});

test("percent input and BPS round trip without rounding/clamping invalid input", () => {
  for (const [input, expected] of [
    ["10", 1000],
    ["7.5", 750],
    ["7,5", 750],
    ["12.25", 1225],
    ["0", 0],
    ["50", 5000],
  ])
    assert.equal(percentToBps(input), expected);
  for (const input of ["50.01", "-1", "NaN", "1.234", ""])
    assert.equal(percentToBps(input), null);
  assert.equal(bpsPercent(750), "7,5");
  assert.deepEqual(weightRange(1000, 750), { min: 925, max: 1075 });
  assert.equal(lineAmount(100000, 1037, 1000), 103700);
});
