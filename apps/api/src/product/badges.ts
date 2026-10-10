import { Prisma, type HitMode, type SeasonalMode } from '../db/gen/client.js';
import { moscowDay } from '../admin/shop-hours.js';

export type HitProduct = { isHit?: boolean; hitMode?: HitMode };
export function hitActive(product: HitProduct) {
  return product.hitMode === 'MANUAL' || (product.hitMode !== 'OFF' && product.isHit === true);
}
export function hitWhere(): Prisma.ProductWhereInput {
  return { OR: [{ hitMode: 'MANUAL' }, { hitMode: 'AUTO', isHit: true }] };
}
export function hitSql() {
  return Prisma.sql`(p."hitMode" = 'MANUAL' OR (p."hitMode" = 'AUTO' AND p."isHit"))`;
}

export type SeasonalProduct = {
  isSeasonal?: boolean;
  seasonalStartsAt?: Date | null;
  seasonalEndsAt?: Date | null;
  seasonalMode?: SeasonalMode;
  seasonTemplate?: { active: boolean; startMonth: number; endMonth: number } | null;
};

export function moscowMonth(now: Date) { return Number(moscowDay(now).slice(5, 7)); }

export function seasonMonths(month: number, start: number, end: number) {
  return start <= end ? month >= start && month <= end : month >= start || month <= end;
}

export function seasonalActive(product: SeasonalProduct, now = new Date()) {
  if (product.seasonalMode === 'OFF') return false;
  if (product.seasonalMode === 'MANUAL') return true;
  if (product.seasonalMode === 'AUTO') {
    const template = product.seasonTemplate;
    return Boolean(template?.active && seasonMonths(moscowMonth(now), template.startMonth, template.endMonth));
  }
  // Compatibility for old snapshots without the mode; new DB reads always have it.
  return Boolean(product.isSeasonal &&
    (!product.seasonalStartsAt || product.seasonalStartsAt <= now) &&
    (!product.seasonalEndsAt || product.seasonalEndsAt > now));
}

export function seasonalWhere(now: Date): Prisma.ProductWhereInput {
  const month = moscowMonth(now);
  const starts = Array.from({ length: 12 }, (_, index) => index + 1);
  return { OR: [
    { seasonalMode: 'MANUAL' },
    { seasonalMode: 'AUTO', seasonTemplate: { active: true, OR: starts.map(startMonth => ({
      startMonth, endMonth: { in: starts.filter(endMonth => seasonMonths(month, startMonth, endMonth)) },
    })) } },
  ] };
}

// Reuse the same calendar predicate in the SQL feed without loading all products.
export function seasonalSql(now: Date) {
  const month = moscowMonth(now);
  return Prisma.sql`(p."seasonalMode" = 'MANUAL' OR (p."seasonalMode" = 'AUTO' AND EXISTS (
    SELECT 1 FROM "SeasonTemplate" s WHERE s.id = p."seasonTemplateId" AND s.active AND
    ((s."startMonth" <= s."endMonth" AND ${month} BETWEEN s."startMonth" AND s."endMonth") OR
     (s."startMonth" > s."endMonth" AND (${month} >= s."startMonth" OR ${month} <= s."endMonth")))
  )))`;
}

export function seasonalBoundary(product: SeasonalProduct, now: Date) {
  if (product.seasonalMode !== 'AUTO' || !product.seasonTemplate?.active || !seasonalActive(product, now)) return null;
  // Adjacent start/end months cover the entire year, including wrapped templates.
  if (product.seasonTemplate.startMonth === product.seasonTemplate.endMonth % 12 + 1) return null;
  const year = Number(moscowDay(now).slice(0, 4));
  const end = product.seasonTemplate.endMonth;
  const endYear = year + (moscowMonth(now) > end ? 1 : 0);
  // First day of the following month, midnight Moscow. Date.UTC handles December.
  return new Date(Date.UTC(endYear, end, 1, -3));
}
