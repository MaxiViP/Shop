import { adjustData, productData, shoppingAction, shoppingData } from './shopping-callback.js';
import { afterType, afterText, checkoutInput, checkoutPayload } from './checkout.js';
const revision = '12345678-1234-4234-8234-123456789abc';
describe('shopping callback boundary', () => {
  it.each(['catalog', 'cart', 'resume', 'help'])('accepts command %s', (kind) =>
    expect(shoppingAction(kind)).toEqual({ kind }),
  );
  it.each([
    ['c', 10000],
    ['k', 10000],
    ['l', 2147483647, 10000],
    ['v', 2147483647, 1000000],
    ['a', revision, 2147483647, 1000000],
    ['a', revision, 2147483647, 1000000, 'GRAM'],
    ['+', revision, 2147483647],
    ['-', revision, 1],
    ['x', revision, 1],
    ['z', revision],
    ['y', revision],
    ['b', revision],
    ['f', revision, 'confirm'],
    ['f', revision, 'edit_address'],
    ['f', revision, 'edit_comment'],
    ['f', revision, 'edit_name'],
    ['f', revision, 'edit_phone'],
    ['f', revision, 'edit_type'],
    ['f', revision, 'edit_time'],
    ['f', revision, 'edit_done'],
    ['p', revision, 'CARD_TRANSFER'],
    ['r', revision, 'SBP'],
  ])('roundtrips maximum bounded callback %s', (...parts) => {
    const data = shoppingData(parts[0] as string, ...parts.slice(1));
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(shoppingAction(data)).not.toBeNull();
  });
  it.each([
    's:a:bad:1:1',
    's:v:0:1',
    's:v:1:0',
    's:v:1:lfls1',
    's:c:zzzzzz',
    's:l:-1:0',
    's:v:+1:1',
    's:v:01:1',
    's:v:1:1e9999',
    's:__proto__:1',
    's:f:' + revision + ':confirm',
    shoppingData('f', revision, 'PAID'),
    shoppingData('r', revision, 'CASH'),
    'x'.repeat(65),
    shoppingData('a', revision, 2147483648, 1),
    shoppingData('a', revision, 1, 1, 'MONEY'),
    shoppingData('a', revision, 1, 1, ''),
    shoppingData('v', 1, 1, 'GRAM'),
  ])('rejects malformed callback without coercion', (data) => {
    expect(shoppingAction(data)).toBeNull();
  });
  it('carries the displayed quantity unit so old buttons cannot silently change sale units', () => {
    expect(shoppingAction(shoppingData('a', revision, 7, 2, 'PIECE'))).toEqual({
      kind: 'add', productId: 7, qty: 2, revision, quantityUnit: 'PIECE',
    });
  });
  it.each(['GRAM', 'PIECE', 'BUNCH', 'PACK'] as const)('roundtrips category context and maximum %s mutations in 63 bytes', unit => {
    const context = { page: 10000, origin: 'category' as const, categoryId: 2147483647 };
    for (const delta of [-1000000, 1000000]) {
      const data = adjustData(revision, 2147483647, delta, unit, context);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(63);
      expect(shoppingAction(data)).toEqual({ kind: 'adjust', revision, productId: 2147483647, delta, quantityUnit: unit, ...context });
    }
    for (const details of [false, true]) {
      const data = productData(2147483647, context, details);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(shoppingAction(data)).toEqual({ kind: details ? 'details' : 'open', productId: 2147483647, ...context });
    }
  });
  it.each(['category', 'basket', 'quick'] as const)('preserves existing %s callbacks with no category ID', origin => {
    const context = { page: 9, origin };
    expect(shoppingAction(productData(17, context))).toEqual({ kind: 'open', productId: 17, ...context });
    expect(shoppingAction(adjustData(revision, 17, -2, 'BUNCH', context)))
      .toEqual({ kind: 'adjust', productId: 17, delta: -2, quantityUnit: 'BUNCH', revision, ...context });
  });
  it.each(['c0', 'c01', 'c-1', 'c+1', 'czzzzzz', 'c1000000', 'c1:extra', 'c__proto__', 'x1'])('rejects malformed category context %s', origin => {
    expect(shoppingAction('s:o:h:0:' + origin)).toBeNull();
    expect(shoppingAction(shoppingData('u', revision, 17, 'p1', 'g', 0, 'c2').replace(/:c2$/, ':' + origin))).toBeNull();
  });
  it.each(['__proto__', 'constructor', 'G', 'w', ''])('rejects unknown compact quantity unit %s', unit => {
    expect(shoppingAction(shoppingData('u', revision, 17, 'p1', unit, 0, 'c2'))).toBeNull();
  });
});
describe('checkout input uses domain fields', () => {
  const payload = () =>
    checkoutPayload.parse({
      cartRevision: revision,
      quoteToken: 'a'.repeat(64),
      type: 'DELIVERY',
    });
  it('returns edited contact fields directly to confirmation when the remaining data is valid', () => {
    const data = { ...payload(), customerName: 'Покупатель', customerPhone: '+79990000007',
      address: { city: 'Москва', street: 'Тестовая', house: '1' }, fulfillmentMode: 'ASAP' as const };
    expect(afterType(data)).toBe('CONFIRM');
    expect(afterText('NAME', data)).toBe('CONFIRM');
    expect(afterText('PHONE', data)).toBe('CONFIRM');
    expect(afterText('COMMENT', data)).toBe('CONFIRM');
    expect(afterType({ ...data, address: undefined })).toBe('ADDRESS');
    expect(afterType({ ...data, fulfillmentMode: undefined })).toBe('TIME');
    expect(afterType({ ...data, customerPhone: undefined })).toBe('PHONE');
  });
  it('normalizes only order contact phone without adding account fields', () => {
    const input = checkoutInput('PHONE', '8 (999) 123-45-67', payload());
    expect(input.customerPhone).toBe('+79991234567');
    expect(input).not.toHaveProperty('user');
  });
  it('parses Moscow future schedule and optional fields', () => {
    expect(
      checkoutInput('TIME', '01.01.2099 12:30', payload()).scheduledFor,
    ).toBe('2099-01-01T09:30:00.000Z');
    expect(checkoutInput('FLAT', '-', payload()).address?.flat).toBe('');
  });
  it.each([
    '29.02.2099 12:00',
    '01.01.2000 12:00',
    '01.01.2099 25:00',
    'garbage',
  ])('rejects invalid date', (text) => {
    expect(() => checkoutInput('TIME', text, payload())).toThrow();
  });
  it('rejects oversized fields and impossible steps', () => {
    expect(() => checkoutInput('NAME', 'x'.repeat(101), payload())).toThrow();
    expect(() => checkoutInput('CONFIRM', 'yes', payload())).toThrow();
  });
});


it('keeps legacy clear as a safe confirmation request and requires a distinct confirmed callback', () => {
  expect(shoppingAction(shoppingData('z', revision))).toEqual({ kind: 'clear', revision });
  expect(shoppingAction(shoppingData('y', revision))).toEqual({ kind: 'clearConfirmed', revision });
  expect(shoppingAction(shoppingData('y', revision, 1))).toBeNull();
});
