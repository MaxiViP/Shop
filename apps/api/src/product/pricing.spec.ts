import { BadRequestException } from '@nestjs/common';
import { customerPrice, priceBreakdown, SERVICE_MARKUP_PERCENT } from './pricing.js';
import { customerProduct } from './select.js';
import { cartQuote } from '../order/cart-quote.js';
import { lineAmount } from '../order/assembly.js';
import { categories, marketProducts, sourceCheckedAt } from '../../data/market-products/2026-10-06.js';
import { validateMarketProducts } from '../../data/market-products/import.js';

describe('KorzinaMarket seller/customer pricing', () => {
  it.each([[10000, 11000], [22000, 24200], [49500, 54450], [40600, 44660],
    [83100, 91410], [71900, 79090], [30900, 33990], [42900, 47190]])(
    '%i seller kopecks become %i customer kopecks', (seller, customer) => {
      expect(customerPrice(seller)).toBe(customer);
      expect(priceBreakdown(seller)).toEqual({ sellerPrice: seller, customerPrice: customer,
        serviceMarkup: customer - seller, serviceMarkupPercent: SERVICE_MARKUP_PERCENT });
    });
  it('uses positive half-up rounding for the unit price, then for the quantity', () => {
    for (const seller of [1, 4, 5, 6, 14, 15, 16, 100000000]) {
      const expected = Number((BigInt(seller) * 110n + 50n) / 100n);
      expect(customerPrice(seller)).toBe(expected);
      expect(Number.isInteger(customerPrice(seller))).toBe(true);
    }
    expect(lineAmount(customerPrice(5), 1, 2)).toBe(3);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2147483647])('rejects invalid or overflowing seller price %s', seller => {
    expect(() => customerPrice(seller)).toThrow(BadRequestException);
  });
  it('allows a future percentage without changing the money representation', () => {
    expect(customerPrice(22000, 12)).toBe(24640);
    expect(customerPrice(22000, 15)).toBe(25300);
    expect(customerPrice(22000, 0)).toBe(22000);
    expect(() => customerPrice(22000, .5)).toThrow(BadRequestException);
  });
  it('does not mutate the source or accumulate markup when it is serialized repeatedly', () => {
    const source = { price: 10000, marketPoint: null };
    expect(customerProduct(source).price).toBe(11000);
    expect(customerProduct(source).price).toBe(11000);
    expect(source.price).toBe(10000);
    source.price = 20000;
    expect(customerProduct(source).price).toBe(22000);
  });
  it('cart products, line totals and subtotal share the same customer price', () => {
    const source = { id: 1, name: 'Рис', slug: 'rice', price: 22000, unit: 'PIECE' as const,
      priceQty: 1, min: 1, step: 1, portionQty: 1, marketPoint: null, images: [],
      category: { name: 'Бакалея', slug: 'grocery' } };
    const quote = cartQuote(new Map([[1, 2]]), [source]);
    expect(quote.subtotal).toBe(48400);
    expect(quote.items[0]).toMatchObject({ product: { price: 24200 }, lineTotal: 48400 });
    expect(source.price).toBe(22000);
  });
  it('hides an unpublished market point while retaining the product customer price', () => {
    expect(customerProduct({ price: 22000, marketPoint: { slug: 'cezoni-market', name: 'CEZONI', isPublished: false } }))
      .toEqual({ price: 24200, marketPoint: null });
    expect(customerProduct({ price: 22000, marketPoint: { slug: 'cezoni-market', name: 'CEZONI', isPublished: true } }))
      .toEqual({ price: 24200, marketPoint: { slug: 'cezoni-market', name: 'CEZONI' } });
  });
});

describe('dated market product dataset', () => {
  it('has exactly 34 CEZONI and 6 Grand Bazar products with unique seller-scoped slugs', () => {
    expect(validateMarketProducts(marketProducts)).toEqual({ 'cezoni-market': 34, 'grand-bazar': 6 });
    expect(marketProducts).toHaveLength(40);
    expect(new Set(marketProducts.map(row => row.slug)).size).toBe(40);
    expect(categories).toHaveLength(7);
  });
  it('contains only positive seller kopecks, piece quantities and a fixed source date', () => {
    for (const row of marketProducts) {
      expect(row).toMatchObject({ unit: 'PIECE', priceQty: 1, step: 1, min: 1, portionQty: 1, sourceCheckedAt });
      expect(Number.isInteger(row.sellerPrice)).toBe(true);
      expect(row.sellerPrice).toBeGreaterThan(0);
      expect(row).not.toHaveProperty('images');
      expect(row).not.toHaveProperty('photoUrl');
    }
    expect(marketProducts[0]!.sellerPrice).toBe(22000);
    expect(new Date(sourceCheckedAt).toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });
  it('rejects duplicates, missing rows and zero prices before any DB work', () => {
    expect(() => validateMarketProducts(marketProducts.slice(1))).toThrow('ожидалось 34');
    expect(() => validateMarketProducts([marketProducts[0]!, ...marketProducts])).toThrow('Повторяющийся');
    expect(() => validateMarketProducts(marketProducts.map((row, index) => index ? row : { ...row, sellerPrice: 0 }))).toThrow();
  });
});
