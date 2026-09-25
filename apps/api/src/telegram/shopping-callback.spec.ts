import { shoppingAction, shoppingData } from './shopping-callback.js';
import { checkoutInput, checkoutPayload } from './checkout.js';
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
    ['+', revision, 2147483647],
    ['-', revision, 1],
    ['x', revision, 1],
    ['z', revision],
    ['b', revision],
    ['f', revision, 'confirm'],
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
  ])('rejects malformed callback without coercion', (data) => {
    expect(shoppingAction(data)).toBeNull();
  });
});
describe('checkout input uses domain fields', () => {
  const payload = () =>
    checkoutPayload.parse({
      cartRevision: revision,
      quoteToken: 'a'.repeat(64),
      type: 'DELIVERY',
    });
  it('normalizes only order contact phone without adding account fields', () => {
    const input = checkoutInput('PHONE', '8 (999) 123-45-67', payload());
    expect(input.customerPhone).toBe('+79991234567');
    expect(input).not.toHaveProperty('user');
  });
  it('parses Moscow future schedule and optional fields', () => {
    expect(
      checkoutInput('TIME', '01.01.2099 12:30', payload()).deliveryAt,
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
