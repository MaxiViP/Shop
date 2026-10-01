import { assertMarketTime, marketStatusAt } from './shop-hours.js';
import type { DbService } from '../db/db.service.js';
const weekly = Array.from({ length: 7 }, (_, index) => ({
  weekday: index + 1, enabled: true, openMinutes: 540, closeMinutes: 1260,
}));
const date = (iso: string) => new Date(iso);
const calendar = { weekly, exceptions: [] };
describe('Europe/Moscow market hours', () => {
  it.each([
    ['2026-10-01T05:59:00.000Z', false],
    ['2026-10-01T06:00:00.000Z', true],
    ['2026-10-01T17:59:00.000Z', true],
    ['2026-10-01T18:00:00.000Z', false],
  ])('evaluates %s as open=%s', (instant, expected) => {
    expect(marketStatusAt(calendar, date(instant)).isOpen).toBe(expected);
  });
  it('returns the next opening after closing', () => {
    expect(marketStatusAt(calendar, date('2026-10-01T18:00:00.000Z')).nextOpenAt)
      .toBe('2026-10-02T06:00:00.000Z');
  });
  it('prefers a shortened exception to the weekly schedule', () => {
    const status = marketStatusAt({ weekly, exceptions: [{
      date: date('2026-10-01T00:00:00.000Z'), closed: false,
      openMinutes: 540, closeMinutes: 1020,
    }] }, date('2026-10-01T15:00:00.000Z'));
    expect(status).toMatchObject({ isOpen: false, closeTime: '17:00' });
  });
  it('closes a whole exception day and finds the following opening', () => {
    const status = marketStatusAt({ weekly, exceptions: [{
      date: date('2026-10-01T00:00:00.000Z'), closed: true,
      openMinutes: null, closeMinutes: null,
    }] }, date('2026-10-01T07:00:00.000Z'));
    expect(status).toMatchObject({ isOpen: false, openTime: null,
      nextOpenAt: '2026-10-02T06:00:00.000Z' });
  });
  it('honors shortened New Year’s Eve and a closed New Year across the year boundary', async () => {
    const exceptions = [
      { date: date('2026-12-31T00:00:00.000Z'), closed: false,
        openMinutes: 540, closeMinutes: 1020 },
      { date: date('2027-01-01T00:00:00.000Z'), closed: true,
        openMinutes: null, closeMinutes: null },
    ];
    const calendar = { weekly, exceptions };
    expect(marketStatusAt(calendar, date('2026-12-31T13:59:00.000Z')).isOpen).toBe(true);
    expect(marketStatusAt(calendar, date('2026-12-31T14:00:00.000Z')))
      .toMatchObject({ isOpen: false, closeTime: '17:00',
        nextOpenAt: '2027-01-02T06:00:00.000Z' });
    expect(marketStatusAt(calendar, date('2027-01-01T07:00:00.000Z')))
      .toMatchObject({ isOpen: false, openTime: null,
        nextOpenAt: '2027-01-02T06:00:00.000Z' });
    const db = { shopHours: { findMany: vi.fn().mockResolvedValue(weekly) },
      shopHoursException: { findMany: vi.fn().mockResolvedValue(exceptions) } } as unknown as DbService;
    await expect(assertMarketTime(db, date('2026-12-31T10:00:00.000Z'),
      date('2027-01-01T07:00:00.000Z')))
      .rejects.toMatchObject({ status: 409, response: { code: 'SHOP_HOURS_INVALID' } });
    await expect(assertMarketTime(db, date('2026-12-31T10:00:00.000Z'),
      date('2027-01-02T06:00:00.000Z'))).resolves.toBeUndefined();
  });
  it('enforces checkout on server even if an earlier browser status was open', async () => {
    const db = { shopHours: { findMany: vi.fn().mockResolvedValue(weekly) },
      shopHoursException: { findMany: vi.fn().mockResolvedValue([{
        date: date('2026-10-01T00:00:00.000Z'), closed: true,
        openMinutes: null, closeMinutes: null,
      }]) } } as unknown as DbService;
    await expect(assertMarketTime(db, date('2026-10-01T07:00:00.000Z')))
      .rejects.toMatchObject({ status: 409, response: { code: 'SHOP_CLOSED' } });
    await expect(assertMarketTime(db, date('2026-10-01T07:00:00.000Z'),
      date('2026-10-02T08:00:00.000Z'))).resolves.toBeUndefined();
  });
});
