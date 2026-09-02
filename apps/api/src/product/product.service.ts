import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import type { ProductQuery, ProductSort } from './schema.js';
import { productListSelect } from './select.js';

@Injectable()
export class ProductService {
  constructor(private readonly db: DbService) {}

  async list(query: ProductQuery) {
    const where: Prisma.ProductWhereInput = {
      active: true,
      category: query.category ? { slug: query.category } : undefined,
      id: query.ids ? { in: query.ids } : undefined,
      OR: query.q
        ? [
            { name: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [items, total] = await this.db.$transaction([
      this.db.product.findMany({
        where,
        select: productListSelect,
        orderBy: this.orderBy(query.sort),
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.product.count({ where }),
    ]);

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    };
  }

  async get(slug: string) {
    const product = await this.db.product.findFirst({
      where: {
        slug,
        active: true,
      },

      select: {
        ...productListSelect,
        description: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private orderBy(sort: ProductSort): Prisma.ProductOrderByWithRelationInput[] {
    if (sort === 'price_asc') return [{ price: 'asc' }, { name: 'asc' }];
    if (sort === 'price_desc') return [{ price: 'desc' }, { name: 'asc' }];
    if (sort === 'newest') return [{ createdAt: 'desc' }, { name: 'asc' }];
    if (sort === 'name') return [{ name: 'asc' }];

    return [{ sort: 'asc' }, { name: 'asc' }];
  }
}
