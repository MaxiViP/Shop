import { hitActive, hitWhere, moscowMonth, seasonMonths, seasonalActive, seasonalBoundary } from './badges.js';
import { customerProduct } from './select.js';
const now = new Date('2026-10-10T09:00:00.000Z');
describe('Independent hit overrides', () => {
  it.each([
    ['AUTO', false, false], ['AUTO', true, true], ['MANUAL', false, true],
    ['MANUAL', true, true], ['OFF', false, false], ['OFF', true, false],
  ] as const)('%s overrides the automatic result %s to %s', (hitMode, isHit, expected) => {
    expect(hitActive({ hitMode, isHit })).toBe(expected);
  });
  it.each(['AUTO', 'MANUAL', 'OFF'] as const)('keeps %s independent of seasonal states and does not alter the input', hitMode => {
    for (const seasonalMode of ['MANUAL', 'OFF'] as const) {
      const input = { price: 10_000, marketPoint: null, hitMode, isHit: true, isSeasonal: true, seasonalMode };
      const saved = { ...input };
      const output = customerProduct(input);
      expect(output.isHit).toBe(hitMode !== 'OFF');
      expect(output.isSeasonal).toBe(seasonalMode === 'MANUAL');
      expect(output).not.toHaveProperty('hitMode');
      expect(input).toEqual(saved);
    }
    expect(hitWhere()).toEqual({ OR: [{ hitMode: 'MANUAL' }, { hitMode: 'AUTO', isHit: true }] });
  });
});
describe('Manual product badges and seasonal intervals', () => {
  it('requires the manual flag and supports an open interval', () => {
    expect(seasonalActive({}, now)).toBe(false);
    expect(seasonalActive({ isSeasonal: true }, now)).toBe(true);
    expect(seasonalActive({ isSeasonal: false, seasonalStartsAt: now }, now)).toBe(false);
  });
  it('includes the start and excludes the end without using the month', () => {
    expect(seasonalActive({ isSeasonal: true, seasonalStartsAt: now }, now)).toBe(true);
    expect(seasonalActive({ isSeasonal: true, seasonalStartsAt: new Date(now.getTime() + 1) }, now)).toBe(false);
    expect(seasonalActive({ isSeasonal: true, seasonalEndsAt: now }, now)).toBe(false);
    expect(seasonalActive({ isSeasonal: true, seasonalEndsAt: new Date(now.getTime() + 1) }, now)).toBe(true);
  });
  it('does not change prices or the independent HIT flag', () => {
    const product = customerProduct({ price: 10_000, marketPoint: null, isHit: true, isSeasonal: true,
      seasonalEndsAt: new Date('2000-01-01T00:00:00Z') });
    expect(product).toMatchObject({ price: 11_000, isHit: true, isSeasonal: false });
  });
});

describe('Annual seasons by the Moscow calendar', () => {
  const template = { active: true, startMonth: 11, endMonth: 2 };
  it.each([[1, 12], [11, 10], [2, 1]])('never expires a continuous full-year template %s–%s', (startMonth, endMonth) => {
    const product = { seasonalMode: 'AUTO' as const, seasonTemplate: { active: true, startMonth, endMonth } };
    for (const at of ['2026-10-31T21:00:00Z', '2026-12-31T21:00:00Z', '2028-02-29T21:00:00Z']) {
      expect(seasonalActive(product, new Date(at))).toBe(true);
      expect(seasonalBoundary(product, new Date(at))).toBeNull();
    }
  });
  it.each([11, 12, 1, 2])('includes month %s in a season crossing New Year', month => {
    expect(seasonMonths(month, 11, 2)).toBe(true);
  });
  it.each([3, 4, 5, 6, 7, 8, 9, 10])('excludes month %s from a season crossing New Year', month => {
    expect(seasonMonths(month, 11, 2)).toBe(false);
  });
  it('uses Moscow midnight and repeats in subsequent years', () => {
    const product = { seasonalMode: 'AUTO' as const, seasonTemplate: template };
    expect(moscowMonth(new Date('2026-10-31T20:59:59.999Z'))).toBe(10);
    expect(seasonalActive(product, new Date('2026-10-31T20:59:59.999Z'))).toBe(false);
    expect(seasonalActive(product, new Date('2026-10-31T21:00:00.000Z'))).toBe(true);
    expect(seasonalActive(product, new Date('2027-02-28T21:00:00.000Z'))).toBe(false);
    expect(seasonalActive(product, new Date('2027-10-31T21:00:00.000Z'))).toBe(true);
    expect(seasonalBoundary(product, new Date('2026-12-31T21:00:00Z'))?.toISOString()).toBe('2027-02-28T21:00:00.000Z');
    expect(seasonalBoundary(product, new Date('2027-12-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T21:00:00.000Z');
  });
  it('supports same-month seasons, whole-year templates, disabling and explicit overrides', () => {
    expect(seasonMonths(10, 10, 10)).toBe(true);
    expect(seasonMonths(11, 10, 10)).toBe(false);
    expect(seasonMonths(6, 1, 12)).toBe(true);
    expect(seasonalActive({ seasonalMode: 'AUTO', seasonTemplate: { ...template, active: false } }, now)).toBe(false);
    expect(seasonalActive({ seasonalMode: 'AUTO', seasonTemplate: null }, now)).toBe(false);
    expect(seasonalActive({ seasonalMode: 'MANUAL', seasonTemplate: null, seasonalEndsAt: new Date(0) }, now)).toBe(true);
    expect(seasonalActive({ seasonalMode: 'OFF', isSeasonal: true, seasonTemplate: template }, now)).toBe(false);
  });
});
