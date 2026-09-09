import { BadRequestException } from '@nestjs/common';
import {
  lineAmount,
  outsideTolerance,
  weightRange,
  sumAmounts,
  approvedWeight,
} from './assembly.js';
import { goodsLine, goodsSum } from './pricing.js';
import { settingsSchema } from '../admin/settings.ctrl.js';
import { reportSchema, requirePaid } from './payment.js';

describe('Assembly integer rules', () => {
  it('approval covers only a resolved exact weight, not another version/state', () => {
    const issue = { status: 'RESOLVED', resolution: 'ACCEPT_ACTUAL', actualQty: 2000, approvedActualQty: 2000 };
    expect(approvedWeight(issue, 2000)).toBe(true);
    expect(approvedWeight(issue, 2100)).toBe(false);
    expect(approvedWeight({ ...issue, status: 'WAITING_CUSTOMER' }, 2000)).toBe(false);
    expect(approvedWeight(undefined, 2000)).toBe(false);
  });
  it.each([963, 1004, 1037, 1082])(
    'prices actual weight %i using snapshot price',
    (actual) => {
      expect(lineAmount(100000, actual, 1000)).toBe(actual * 100);
    },
  );
  it('rounds half a kopeck up deterministically', () => {
    expect(lineAmount(1, 1, 2)).toBe(1);
    expect(lineAmount(1, 1, 3)).toBe(0);
  });
  it.each([
    [1000, 900, false],
    [1000, 1100, false],
    [1000, 899, true],
    [1000, 1101, true],
    [1000, 2000, true],
    [750, 925, false],
    [750, 1075, false],
    [750, 924, true],
    [750, 1076, true],
    [0, 1000, false],
    [0, 1001, true],
  ])('tolerance %i with actual %i outside=%s', (bps, actual, outside) =>
    expect(outsideTolerance('GRAM', 1000, actual, bps)).toBe(outside),
  );
  it('does not apply weight tolerance to discrete items', () => {
    for (const unit of ['PIECE', 'PACK', 'BUNCH'])
      expect(outsideTolerance(unit, 1, 2, 0)).toBe(false);
  });
  it('uses inward rounding for an integer allowed range', () =>
    expect(weightRange(7, 1000)).toEqual({ min: 7, max: 7 }));
  it.each([0, -1, 1.5, 1000001, Number.MAX_SAFE_INTEGER])(
    'rejects invalid qty %i as a business error',
    (qty) => {
      expect(() => goodsLine(100000, qty, 1000)).toThrow(BadRequestException);
    },
  );
  it('bounds each line and aggregate, even with unknown delivery', () => {
    expect(() => goodsLine(100000000, 1000000, 1)).toThrow(BadRequestException);
    expect(() => goodsSum([2147483647, 1])).toThrow(BadRequestException);
    expect(sumAmounts([103700, 0])).toBe(103700);
  });
  it.each([-1, 5001, 7.5, NaN])('rejects invalid setting %s', (value) =>
    expect(
      settingsSchema.safeParse({ weightToleranceBps: value }).success,
    ).toBe(false),
  );
  it('accepts 7.5% as 750 BPS and rejects mass assignment in report', () => {
    expect(
      settingsSchema.parse({ weightToleranceBps: 750 }).weightToleranceBps,
    ).toBe(750);
    expect(
      reportSchema.safeParse({ method: 'SBP', status: 'PAID', amount: 1 })
        .success,
    ).toBe(false);
  });
  it.each(['AWAITING', 'REPORTED', 'CANCELED'])(
    'blocks delivery for %s payment',
    (status) => {
      expect(() =>
        requirePaid({
          assemblyFinalizedAt: new Date(),
          finalSubtotal: 100,
          payment: { status, amount: 100 },
        }),
      ).toThrow();
    },
  );
});
