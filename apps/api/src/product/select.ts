import type { Prisma } from '../db/gen/client.js';

export const productListSelect = {
  id: true,
  name: true,
  slug: true,
  price: true,
  priceQty: true,
  unit: true,
  step: true,
  min: true,
  category: {
    select: {
      name: true,
      slug: true,
    },
  },
  images: {
    select: {
      url: true,
      alt: true,
    },
    orderBy: {
      sort: 'asc',
    },
  },
} satisfies Prisma.ProductSelect;
