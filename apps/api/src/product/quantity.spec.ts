import { MAX_QTY, manualQuantity, quantityErrors, quickQuantity, validQuantity } from '../order/assembly.js';
import { productSchema } from '../admin/schema.js';

const cases = [
  { unit: 'GRAM', min: 500, step: 100, portionQty: 500, quick: [500, 1000, 1500], manual: [500, 600, 700] },
  { unit: 'GRAM', min: 500, step: 250, portionQty: 1000, quick: [1000, 2000, 3000], manual: [500, 750, 1000] },
  { unit: 'GRAM', min: 300, step: 100, portionQty: 500, quick: [500, 1000, 1500], manual: [300, 400, 500] },
  { unit: 'PIECE', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
  { unit: 'PIECE', min: 1, step: 1, portionQty: 2, quick: [2, 4, 6], manual: [1, 2, 3] },
  { unit: 'PIECE', min: 2, step: 1, portionQty: 2, quick: [2, 4, 6], manual: [2, 3, 4] },
  { unit: 'PIECE', min: 2, step: 2, portionQty: 4, quick: [4, 8, 12], manual: [2, 4, 6] },
  { unit: 'PACK', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
  { unit: 'BUNCH', min: 1, step: 1, portionQty: 1, quick: [1, 2, 3], manual: [1, 2, 3] },
];

describe('Product quantity semantics', () => {
  it.each(cases)('$unit min=$min step=$step portion=$portionQty', (config) => {
    expect(quantityErrors(config)).toEqual({});
    const { unit, min, step, portionQty } = config;
    expect(productSchema.safeParse({
      name: 'Товар', slug: 'product', description: null, price: 15000,
      priceQty: 500, categoryId: 1, active: true, sort: 0, unit, min, step, portionQty,
    }).success).toBe(true);
    let current: number | undefined;
    for (const expected of config.quick) {
      current = quickQuantity(current, config)!;
      expect(current).toBe(expected);
      expect(validQuantity(current, config)).toBe(true);
    }
    expect(quickQuantity(0, config)).toBe(config.portionQty);
    let manual = config.min;
    for (const expected of config.manual.slice(1)) {
      manual = manualQuantity(manual, config, 1)!;
      expect(manual).toBe(expected);
    }
    for (const expected of config.manual.slice(0, -1).reverse()) {
      manual = manualQuantity(manual, config, -1)!;
      expect(manual).toBe(expected);
    }
    expect(manualQuantity(manual, config, -1)).toBe(config.min);
  });

  for (const field of ['min', 'step', 'portionQty'] as const) {
    it.each([0, -1, 1.5, NaN, Infinity, MAX_QTY + 1, Number.MAX_SAFE_INTEGER + 1])(
      `rejects invalid ${field}=%s`, (value) => {
        const config = { min: 500, step: 100, portionQty: 500, [field]: value };
        expect(quantityErrors(config)[field]).toBeTruthy();
        expect(quickQuantity(undefined, config)).toBeNull();
      },
    );
  }
  it.each([
    { min: 500, step: 300, portionQty: 500 },
    { min: 500, step: 100, portionQty: 550 },
    { min: 500, step: 100, portionQty: 100 },
  ])('rejects incompatible configuration %j without rounding', (config) => {
    expect(Object.keys(quantityErrors(config)).length).toBeGreaterThan(0);
    expect(quickQuantity(undefined, config)).toBeNull();
    expect(quickQuantity(500, config)).toBeNull();
  });
  it('preserves validity when manual adjustments and quick additions are mixed', () => {
    for (let step = 1; step <= 12; step++) {
      for (let multiple = 1; multiple <= 10; multiple++) {
        const config = { min: step * multiple, step, portionQty: step * (multiple + 2) };
        let qty = config.min;
        for (let i = 0; i < 20; i++) {
          qty = manualQuantity(qty, config, i % 2 ? -1 : 1)!;
          qty = quickQuantity(qty, config)!;
          expect(validQuantity(qty, config)).toBe(true);
        }
      }
    }
  });
  it.each([499, 501, 0, -1, 500.5, MAX_QTY + 1, Number.MAX_SAFE_INTEGER + 1])(
    'does not round invalid current quantity %s', (qty) => {
      const config = cases[0]!;
      expect(validQuantity(qty, config)).toBe(false);
      if (qty !== 0) expect(quickQuantity(qty, config)).toBeNull();
      expect(manualQuantity(qty, config, 1)).toBeNull();
      expect(manualQuantity(qty, config, -1)).toBeNull();
    },
  );
  it('bounds additions at the common maximum', () => {
    const config = cases[0]!;
    expect(quickQuantity(999500, config)).toBe(MAX_QTY);
    expect(quickQuantity(MAX_QTY, config)).toBeNull();
    expect(manualQuantity(999900, config, 1)).toBe(MAX_QTY);
    expect(manualQuantity(MAX_QTY, config, 1)).toBeNull();
  });
});
