import { financeLine, financeTotals, splitMarkup, type FinanceItem } from './finance.math.js';
const item = (overrides: Partial<FinanceItem> = {}): FinanceItem => ({
  id: 1, productName: 'Помидоры', status: 'PICKED', qty: 1000,
  actualQty: 1000, total: 45000, actualTotal: 45000, priceQty: 1000,
  settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 30000,
  ...overrides,
});
describe('financial snapshot arithmetic', () => {
  it('divides 450 ₽ less 300 ₽ as 75/75 ₽', () => {
    const totals = financeTotals([financeLine(item())]);
    expect(totals).toMatchObject({ sharedRevenue: 45000, baseAmount: 30000,
      sharedMarkup: 15000, partner1Share: 7500, partner2Share: 7500 });
  });
  it('excludes NO_MARKUP while retaining its revenue', () => {
    expect(financeTotals([financeLine(item({ settlementModeSnapshot: 'NO_MARKUP', basePriceSnapshot: null }))]))
      .toMatchObject({ noMarkupRevenue: 45000, sharedMarkup: 0 });
  });
  it('prices actual 750 g with the same half-up integer rule', () => {
    const line = financeLine(item({ actualQty: 750, actualTotal: 33750 }));
    expect(line).toMatchObject({ saleAmount: 33750, baseAmount: 22500, sharedMarkup: 11250 });
    expect(financeLine(item({ actualQty: 1, actualTotal: 1, basePriceSnapshot: 1, priceQty: 2 })).baseAmount).toBe(1);
  });
  it('does not read changed Product.basePrice or Product.settlementMode', () => {
    const snapshot = item();
    const product = { basePrice: 32000, settlementMode: 'NO_MARKUP' };
    expect(product.basePrice).toBe(32000);
    expect(product.settlementMode).toBe('NO_MARKUP');
    expect(financeLine(snapshot).sharedMarkup).toBe(15000);
  });
  it('uses the replacement item snapshot, not the missing original', () => {
    const missing = financeLine(item({ status: 'MISSING', actualQty: 0, actualTotal: 0 }));
    const replacement = financeLine(item({ id: 2, productName: 'Замена', basePriceSnapshot: 20000 }));
    expect(financeTotals([missing, replacement]).sharedMarkup).toBe(25000);
  });
  it('does not count a MISSING item', () => {
    expect(financeLine(item({ status: 'MISSING', actualQty: 0, actualTotal: 0 })))
      .toMatchObject({ saleAmount: 0, baseAmount: 0, sharedMarkup: 0 });
  });
  it('keeps negative margin visible', () => {
    expect(financeLine(item({ actualTotal: 20000 }))).toMatchObject({ sharedMarkup: -10000 });
  });
  it('splits odd positive and negative kopecks without losing one', () => {
    expect(splitMarkup(1n)).toEqual({ partner1Share: 0, partner2Share: 1 });
    expect(splitMarkup(-1n)).toEqual({ partner1Share: 0, partner2Share: -1 });
    expect(splitMarkup(101n)).toEqual({ partner1Share: 50, partner2Share: 51 });
    expect(splitMarkup(-101n)).toEqual({ partner1Share: -50, partner2Share: -51 });
  });
  it('separates UNSET and legacy from shared markup', () => {
    const lines = [financeLine(item({ settlementModeSnapshot: 'UNSET', basePriceSnapshot: null })),
      financeLine(item({ id: 2, settlementModeSnapshot: null, basePriceSnapshot: null }))];
    expect(financeTotals(lines)).toMatchObject({ unsetRevenue: 45000, legacyRevenue: 45000,
      legacyItemsCount: 1, sharedMarkup: 0 });
  });
  it('does not count delivery or extras as shared markup or twice as turnover', () => {
    expect(financeTotals([financeLine(item())], 700, 500)).toMatchObject({
      turnover: 46200, goodsRevenue: 45000, extras: 700, delivery: 500, sharedMarkup: 15000,
    });
    expect(financeTotals([financeLine(item({ total: 100000, actualTotal: 100000,
      basePriceSnapshot: 60000 }))], 20000, 30000)).toMatchObject({
      goodsRevenue: 100000, extras: 20000, delivery: 30000,
      turnover: 150000, sharedMarkup: 40000,
    });
  });
});
