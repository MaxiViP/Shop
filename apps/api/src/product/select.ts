import type { Prisma } from '../db/gen/client.js';
import { customerPrice } from './pricing.js';
import { hitActive, seasonalActive, seasonalBoundary, type HitProduct, type SeasonalProduct } from './badges.js';

type ProductSource = SeasonalProduct & HitProduct & { price: number; marketPoint: { slug: string; name: string; isPublished: boolean } | null };

export function customerProduct<T extends ProductSource>(product: T) {
  const point = product.marketPoint;
  const { seasonTemplate: _template, seasonalMode: _mode, hitMode: _hitMode, ...fields } = product;
  const now = new Date();
  return { ...fields, price: customerPrice(product.price),
    ...(product.isHit === undefined ? {} : { isHit: hitActive(product) }),
    ...(product.isSeasonal === undefined ? {} : { isSeasonal: seasonalActive(product, now),
      seasonalStartsAt: product.seasonalMode ? null : product.seasonalStartsAt ?? null,
      seasonalEndsAt: product.seasonalMode ? seasonalBoundary(product, now) : product.seasonalEndsAt ?? null }),
    marketPoint: point?.isPublished ? { slug: point.slug, name: point.name } : null };
}

export const productListSelect = {
  id: true,
  name: true,
  slug: true,
  price: true,
  priceStatus: true,
  priceQty: true,
  unit: true,
  step: true,
  min: true,
  portionQty: true,
  isSeasonal: true,
  isHit: true,
  hitMode: true,
  seasonalStartsAt: true,
  seasonalEndsAt: true,
  seasonalMode: true,
  seasonTemplate: { select: { active: true, startMonth: true, endMonth: true } },
  marketPoint: { select: { slug: true, name: true, isPublished: true } },
  category: {
    select: {
      name: true,
      slug: true,
    },
  },
  images: {
    where: { visible: true },
    select: {
      url: true,
      alt: true,
    },
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.ProductSelect;
