import assert from 'node:assert/strict';
import test from 'node:test';
import { eventFields, eventValue } from '../app/utils/events.ts';
import { serviceHelpers } from './fixtures/service-fee.mjs';
const { serviceFeeError } = await serviceHelpers();

test('event values distinguish global and individual zero without treating zero as absent', () => {
  assert.equal(eventValue(null, 'serviceMarkupPercentOverride'), 'Общий');
  assert.equal(eventValue(0, 'serviceMarkupPercentOverride'), 'Индивидуальный (0%)');
  assert.equal(eventValue(10, 'serviceMarkupPercentOverride'), 'Индивидуальный (10%)');
  assert.equal(eventValue(0, 'globalServiceMarkupPercent'), '0');
  for (const field of ['globalServiceMarkupPercent', 'serviceMarkupPercentOverride', 'serviceMarkupPercent', 'serviceMarkupNeedsReview'])
    assert.ok(eventFields[field]);
});

test('revoked global/bulk permission has an actionable message for every HTTP error shape', () => {
  for (const cause of [{status:403}, {statusCode:403}, {response:{status:403}}])
    assert.match(serviceFeeError(cause), /только главный администратор/);
});
