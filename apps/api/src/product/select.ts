import type { Prisma } from '../db/gen/client.js';
import { customerPrice } from './pricing.js';

type ProductSource = { price: number; marketPoint: { slug: string; name: string; isPublished: boolean } | null };

export function customerProduct<T extends ProductSource>(product: T) {
  const point = product.marketPoint;
  return { ...product, price: customerPrice(product.price),
    marketPoint: point?.isPublished ? { slug: point.slug, name: point.name } : null };
}

export const productListSelect = {
  id: true,
  name: true,
  slug: true,
  price: true,
  priceQty: true,
  unit: true,
  step: true,
  min: true,
  portionQty: true,
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
