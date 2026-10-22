import { parseStaffAction, parseStaffQueue, rublesToKopecks, positiveQty, quantity, staffConfirmData, staffData, staffOrderCommand, staffQueueData, weightGrams } from './staff-bot.js';

describe('STAFF callback and human input validation', () => {
  it('accepts compact whitelisted callbacks and keeps them under Telegram 64-byte limit', () => {
    for (const action of ['o', 'i', 'v', 'w', 'q', 'a', 'm', 'r', 'f', 'p', 'u', 'd', 'k',
      'h', 'c', 'x', 'xl', 'xe', 'xd', 'z', 'zb', 'b'] as const) {
      const data = staffData(2147483647, action, ['v', 'w', 'q', 'a', 'm', 'r', 'xe', 'xd'].includes(action) ? 2147483647 : undefined);
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
    's:1:o:4', 's:1:w', 's:1:a', 's:1:k:1', 's:1:v:0', 's:1:v:-1', 's:1:i:2147483648',
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

  it('accepts bounded read-only queue navigation without allowing arbitrary callback actions', () => {
    expect(parseStaffQueue(staffQueueData('seller', 2))).toEqual({ filter: 'seller', page: 2 });
    expect(parseStaffQueue('sq:customer:10000')).toEqual({ filter: 'customer', page: 10000 });
    for (const value of ['sq:all:-1', 'sq:all:01', 'sq:all:10001', 'sq:delete:0', 'sq:all:0\n', 'sq:all:0:6'])
      expect(parseStaffQueue(value)).toBeNull();
    expect(parseStaffAction('s:6:j:5')).toEqual({ orderId: 6, action: 'j', arg: 5 });
  });

  it('accepts explicit kilograms with integer arithmetic and rejects ambiguous fractions', () => {
    expect(weightGrams('1024')).toBe(1024);
    expect(weightGrams('1024 г')).toBe(1024);
    expect(weightGrams('1,024 кг')).toBe(1024);
    expect(weightGrams('1.2 kg')).toBe(1200);
    expect(weightGrams('0,001 кг')).toBe(1);
    expect(weightGrams('1000 кг')).toBe(1_000_000);
    for (const value of ['1,024', '1.024', '1,0245 кг', '0 кг', '-1 кг', '1e3 кг', '1001 кг'])
      expect(weightGrams(value)).toBeNull();
  });
});


describe('STAFF review and quick navigation syntax', () => {
  it.each(['ry', 'xy', 'fy', 'by', 'py'] as const)('binds %s to a bounded durable session code', action => {
    const data = staffConfirmData(2147483647, action, '0123456789abcdef');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseStaffAction(data)).toEqual({ orderId: 2147483647, action, code: '0123456789abcdef' });
    expect(parseStaffAction('s:6:' + action)).toBeNull();
    expect(parseStaffAction(data + '\n')).toBeNull();
  });
  it.each(['new', 'assembly', 'ready', 'delivery'] as const)('supports a bounded %s status queue', filter => {
    expect(parseStaffQueue(staffQueueData(filter, 3))).toEqual({ filter, page: 3 });
    expect(Buffer.byteLength(staffQueueData(filter, 10000))).toBeLessThanOrEqual(64);
  });
  it('parses extra pages and explicit order numbers without treating weight as an order', () => {
    expect(parseStaffAction('s:6:xl:10')).toEqual({ orderId: 6, action: 'xl', arg: 10 });
    for (const value of ['/order 6', '/order #6', '/order_6', '#6']) expect(staffOrderCommand(value)).toBe(6);
    for (const value of ['742', '#0', '#06', '/order -1', '#2147483648', '#6 extra', '#6\n'])
      expect(staffOrderCommand(value)).toBeNull();
  });
});
