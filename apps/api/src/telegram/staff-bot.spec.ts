import { parseStaffAction, rublesToKopecks, positiveQty, quantity, staffConfirmData, staffData } from './staff-bot.js';

describe('STAFF callback and human input validation', () => {
  it('accepts compact whitelisted callbacks and keeps them under Telegram 64-byte limit', () => {
    for (const action of ['o', 'i', 'v', 'w', 'q', 'm', 'r', 'f', 'p', 'u', 'd',
      'h', 'c', 'x', 'xl', 'xe', 'xd', 'z', 'zb', 'b'] as const) {
      const data = staffData(2147483647, action, ['v', 'w', 'q', 'm', 'r', 'xe', 'xd'].includes(action) ? 2147483647 : undefined);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseStaffAction(data)?.orderId).toBe(2147483647);
    }
  });
  it('binds final confirmation to a compact session code', () => {
    const data = staffConfirmData(6, 'xs', '0123456789abcdef');
    expect(parseStaffAction(data)).toEqual({ orderId: 6, action: 'xs', code: '0123456789abcdef' });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseStaffAction('s:6:xs')).toBeNull();
  });
  it.each(['s:0:o', 's:-1:o', 's:2147483648:o', 's:01:o', 's:1:delete',
    's:1:o:4', 's:1:w', 's:1:v:0', 's:1:v:-1', 's:1:i:2147483648',
    's:1:o\n', 'x'.repeat(65)])('rejects malformed callback %s', value => {
    expect(parseStaffAction(value)).toBeNull();
  });
  it('parses rubles using integer kopecks without float arithmetic', () => {
    expect(rublesToKopecks('120,50')).toBe(12050);
    expect(rublesToKopecks('1.2')).toBe(120);
    expect(rublesToKopecks('12345')).toBe(1234500);
    for (const value of ['', '0', '-1', '+1', '1e3', '1.234', 'abc', '99999999'])
      expect(rublesToKopecks(value)).toBeNull();
    expect(quantity(1, 'BUNCH')).toBe('1 пучок');
    expect(quantity(2, 'BUNCH')).toBe('2 пучка');
    expect(positiveQty('742')).toBe(742);
    expect(positiveQty('1.5')).toBeNull();
    expect(positiveQty('0')).toBeNull();
  });
});
