import { estimatedDataset, marketProducts, marketPoints } from '../../data/market-products/2026-10-07-estimated.js';
import { validateMarketProducts } from '../../data/market-products/import.js';
import { customerPrice } from './pricing.js';

describe('draft market catalog', () => {
  it('contains all 17 sellers, 146 products, 139 estimates and 7 source prices', () => {
    expect(marketPoints).toHaveLength(17);
    expect(marketProducts).toHaveLength(146);
    expect(validateMarketProducts(marketProducts, estimatedDataset)).toEqual(estimatedDataset.expectedCounts);
    expect(marketProducts.filter(row => row.priceStatus === 'ESTIMATED')).toHaveLength(139);
    expect(marketProducts.filter(row => row.priceStatus === 'SOURCE')).toHaveLength(7);
    expect(marketProducts.every(row => Number.isSafeInteger(row.sellerPrice) && row.sourceCheckedAt === '2026-10-07T00:00:00.000Z')).toBe(true);
    expect(marketProducts.every(row => !('images' in row))).toBe(true);
  });
  it('uses seller kopecks, weight in grams and stable seller-prefixed slugs', () => {
    const fish = marketProducts.find(row => row.slug === 'romanovskoe-osetrovoe-hozyaystvo-chilled-sturgeon')!;
    expect(fish).toMatchObject({ sellerPrice: 190000, priceStatus: 'ESTIMATED', unit: 'GRAM', priceQty: 1000 });
    expect(customerPrice(fish.sellerPrice)).toBe(209000);
    const caviar = marketProducts.find(row => row.slug.endsWith('black-caviar-standard-30g'))!;
    expect(caviar).toMatchObject({ sellerPrice: 170000, priceStatus: 'SOURCE', unit: 'PIECE', priceQty: 1 });
    expect(marketProducts.every(row => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) && row.slug.startsWith(row.marketPointSlug + '-'))).toBe(true);
  });
});
