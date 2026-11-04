import {
  eventsQuery,
  cursorScope,
  signEventCursor,
  readEventCursor,
  eventWhere,
} from './events-query.js';

describe('Event filters and resumable cursor', () => {
  beforeEach(() =>
    vi.stubEnv('AUTH_SECRET', 'isolated-event-cursor-test-secret'),
  );
  afterEach(() => vi.unstubAllEnvs());
  it('validates dates, bounds and categories', () => {
    for (const input of [
      { category: 'SECURITY' },
      { orderId: -1 },
      { actorId: 2147483648 },
      { from: '2026-02-30' },
      { from: '2026-11-04', to: '2026-11-03' },
      { q: 'x'.repeat(161) },
    ])
      expect(eventsQuery.safeParse(input).success).toBe(false);
    expect(eventsQuery.parse({ ownerOnly: false, category: 'ORDERS' })).toEqual(
      { category: 'ORDERS' },
    );
  });
  it('uses Moscow day boundaries and SQL parameters for full text', () => {
    const filter = eventWhere(
      { from: '2026-11-03', to: '2026-11-03', q: "'); DROP TABLE x; --" },
      false,
    );
    expect(filter.text).toContain('"ownerOnly"=false');
    expect(filter.text).not.toContain('DROP TABLE');
    expect(filter.values).toContainEqual(new Date('2026-11-02T21:00:00Z'));
    expect(filter.values).toContainEqual(new Date('2026-11-03T21:00:00Z'));
  });
  it('binds signed snapshots to viewer, visibility and filters, rejecting tampering and expiry', () => {
    const scope = cursorScope(1, true, { category: 'ORDERS' });
    const token = signEventCursor('10:20:11,12', scope);
    expect(readEventCursor(token, scope).snapshot).toBe('10:20:11,12');
    for (const other of [
      cursorScope(2, true, { category: 'ORDERS' }),
      cursorScope(1, false, { category: 'ORDERS' }),
      cursorScope(1, true, {}),
    ])
      expect(() => readEventCursor(token, other)).toThrow();
    expect(() => readEventCursor(token + 'bad', scope)).toThrow();
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 8 * 86400000);
    expect(() => readEventCursor(token, scope)).toThrow();
    spy.mockRestore();
  });
});
