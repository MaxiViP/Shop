import { clientIp, trustedProxies } from './proxy.js';
import { AttemptLimit } from './attempt-limit.js';

describe('Trusted proxy configuration / client IP', () => {
  it('defaults to no trust and accepts only explicit addresses/subnets', () => {
    expect(trustedProxies('')).toBe(false);
    expect(trustedProxies('false')).toBe(false);
    expect(trustedProxies('127.0.0.1/32, ::1/128')).toEqual([
      '127.0.0.1/32',
      '::1/128',
    ]);
    expect(trustedProxies('10.20.30.0/24')).toEqual(['10.20.30.0/24']);
  });
  it.each([
    'true',
    '1',
    '0',
    '*',
    'loopback',
    '0.0.0.0/0',
    '::/0',
    '127.0.0.1/33',
    '::1/129',
    'bad',
    '127.0.0.1,',
    '::1/1/2',
  ])('fails closed for unsafe/invalid TRUST_PROXY=%s', (value) => {
    expect(() => trustedProxies(value)).toThrow('TRUST_PROXY');
  });
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::ffff:c000:201', '192.0.2.1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['::ffff:0:192.0.2.1', '::ffff:0:c000:201'],
    ['not-an-ip', 'unknown'],
    [undefined, 'unknown'],
  ])('canonicalizes the framework result %s', (ip, expected) => {
    expect(clientIp({ ip })).toBe(expected);
  });
});

describe('AttemptLimit', () => {
  afterEach(() => vi.restoreAllMocks());
  it('does not let rejected calls from A drain the global budget for B', () => {
    const limit = new AttemptLimit(5, 100, 15);
    for (let i = 0; i < 5; i++) limit.check('A');
    for (let i = 0; i < 150; i++) expect(() => limit.check('A')).toThrow();
    expect(() => limit.check('B')).not.toThrow();
  });
  it('keeps the aggregate cap and resets at the exact window boundary', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const limit = new AttemptLimit(5, 100, 15);
    for (let i = 0; i < 100; i++) limit.check(String(i));
    expect(() => limit.check('new')).toThrow();
    vi.mocked(Date.now).mockReturnValue(now + 15 * 60_000);
    expect(() => limit.check('new')).not.toThrow();
  });
});
