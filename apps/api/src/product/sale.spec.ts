import {
  actualQuantity,
  approvedItemWeight,
  compatibleQuantityUnit,
  estimatedQuantity,
  needsWeightApproval,
  saleErrors,
  type WeighedItem,
} from './sale.js';
import { pickedLine, requestedLine } from '../order/pricing.js';
import { productSchema } from '../admin/schema.js';
const whole: WeighedItem & { price: number; priceQty: number } = {
  unit: 'PIECE',
  saleModel: 'WHOLE_VARIABLE_WEIGHT',
  priceUnit: 'GRAM',
  wholeLabel: 'кусок',
  qty: 1,
  actualQty: 1,
  actualWeightGrams: 1780,
  pieceWeights: [1780],
  price: 150000,
  priceQty: 1000,
};
describe('market sale models', () => {
  it('keeps unknown whole weight unknown and calculates only after weighing', () => {
    expect(estimatedQuantity(whole, 1)).toBeNull();
    expect(requestedLine(whole)).toBeNull();
    expect(pickedLine(whole)).toBe(267000);
    expect(needsWeightApproval(whole, 1000)).toBe(false);
    expect(
      needsWeightApproval({ ...whole, estimatedWeightGrams: 500 }, 1000),
    ).toBe(false);
  });
  it('preserves specimen count and individual weights for several whole pieces/fish', () => {
    const fish = {
      ...whole,
      wholeLabel: 'рыба',
      qty: 3,
      actualQty: 3,
      pieceWeights: [412, 531, 489],
      actualWeightGrams: 1432,
    };
    expect(actualQuantity(fish)).toBe(1432);
    expect(pickedLine(fish)).toBe(214800);
    expect(needsWeightApproval(fish, 1000)).toBe(false);
    expect(() => pickedLine({ ...fish, actualQty: 2 })).toThrow();
    expect(() => pickedLine({ ...fish, actualWeightGrams: 1500 })).toThrow();
  });
  it('checks each buyer limit, count and the exact approved weighing', () => {
    const limited = {
      ...whole,
      qty: 2,
      actualQty: 2,
      actualWeightGrams: 3000,
      pieceWeights: [1250, 1750],
      weightMinGrams: 1400,
    };
    expect(needsWeightApproval(limited, 1000)).toBe(true);
    const issue = {
      status: 'RESOLVED',
      resolution: 'ACCEPT_ACTUAL',
      actualQty: 2,
      approvedActualQty: 2,
      approvedWeightGrams: 3000,
      approvedPieceWeights: [1250, 1750],
    };
    expect(approvedItemWeight(issue, limited)).toBe(true);
    expect(
      approvedItemWeight(issue, { ...limited, pieceWeights: [1200, 1800] }),
    ).toBe(false);
    expect(needsWeightApproval({ ...whole, qty: 2 }, 1000)).toBe(true);
  });
  it('supports fixed bunches/packs and variable-weight bunches without inventing 100 g', () => {
    const bunch = {
      ...whole,
      unit: 'BUNCH' as const,
      saleModel: 'BUNCH' as const,
      priceUnit: 'BUNCH' as const,
      priceQty: 1,
      actualWeightGrams: null,
      pieceWeights: null,
    };
    for (const qty of [1, 2, 3])
      expect(requestedLine({ ...bunch, qty })).toBe(150000 * qty);
    expect(
      requestedLine({
        ...bunch,
        unit: 'PACK',
        saleModel: 'PACK',
        priceUnit: 'PACK',
        qty: 3,
      }),
    ).toBe(450000);
    expect(
      requestedLine({ ...bunch, priceUnit: 'GRAM', priceQty: 1000 }),
    ).toBeNull();
    expect(
      pickedLine({
        ...bunch,
        priceUnit: 'GRAM',
        priceQty: 1000,
        pieceWeights: [73],
        actualWeightGrams: 73,
      }),
    ).toBe(10950);
  });
  it('keeps loose actual grams independent of the buyer step and applies percentage tolerance', () => {
    const loose = {
      ...whole,
      unit: 'GRAM' as const,
      saleModel: 'CUT_TO_WEIGHT' as const,
      qty: 500,
      actualQty: 537,
      pieceWeights: null,
      actualWeightGrams: null,
    };
    expect(pickedLine(loose)).toBe(80550);
    expect(needsWeightApproval(loose, 1000)).toBe(false);
    expect(needsWeightApproval({ ...loose, actualQty: 551 }, 1000)).toBe(true);
  });
  it.each([0, -1, 1.5, 1_000_001, Number.NaN])(
    'rejects malformed actual weight %s',
    (weight) => {
      expect(() =>
        pickedLine({
          ...whole,
          actualWeightGrams: weight,
          pieceWeights: [weight],
        }),
      ).toThrow();
    },
  );
  it('validates cross-field admin patches and legacy quantities', () => {
    const data = {
      name: 'Отруб',
      slug: 'bone-cut',
      description: null,
      price: 150000,
      priceQty: 1000,
      unit: 'PIECE',
      min: 1,
      step: 1,
      portionQty: 1,
      saleModel: 'WHOLE_VARIABLE_WEIGHT',
      priceUnit: 'GRAM',
      categoryId: 1,
      active: false,
      sort: 0,
    };
    expect(productSchema.safeParse(data).success).toBe(true);
    expect(
      productSchema.safeParse({ ...data, priceUnit: 'PIECE' }).success,
    ).toBe(false);
    expect(productSchema.safeParse({ ...data, step: 100 }).success).toBe(false);
    expect(
      saleErrors({
        unit: 'PIECE',
        priceQty: 10,
        min: 1,
        step: 1,
        portionQty: 1,
      }),
    ).toEqual({});
  });
  it('never reinterprets specimens as grams or grams as bunches after a model change', () => {
    expect(
      compatibleQuantityUnit('PIECE', { unit: 'GRAM', priceUnit: 'GRAM' }),
    ).toBe(false);
    expect(
      compatibleQuantityUnit('GRAM', { unit: 'BUNCH', priceUnit: 'BUNCH' }),
    ).toBe(false);
    expect(
      compatibleQuantityUnit('PIECE', { unit: 'PACK', priceUnit: 'PACK' }),
    ).toBe(true);
    expect(compatibleQuantityUnit(null, whole)).toBe(false);
  });
});
