import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import type { ProductQuery, ProductSort } from './schema.js';
import { customerProduct, productListSelect } from './select.js';
import { productFeed } from './feed.js';

@Injectable()
export class ProductService {
  constructor(private readonly db: DbService) {}

  async list(query: ProductQuery) {
    if (query.feed) return productFeed(this.db, query);
    if (query.q && query.category) return this.prioritySearch(query);
    const where: Prisma.ProductWhereInput = {
      active: true,
      marketPoint: query.marketPoint ? { slug: query.marketPoint, isPublished: true } : undefined,
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
      items: items.map(customerProduct),
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

    return customerProduct(product);
  }

  private prioritySearch(query: ProductQuery) {
    return this.db.$transaction(async db => {
      const category = await db.category.findUnique({ where: { slug: query.category! },
        select: { slug: true, name: true } });
      const match: Prisma.ProductWhereInput = { active: true,
        marketPoint: query.marketPoint ? { slug: query.marketPoint, isPublished: true } : undefined,
        id: query.ids ? { in: query.ids } : undefined,
        OR: [{ name: { contains: query.q, mode: 'insensitive' } },
          { description: { contains: query.q, mode: 'insensitive' } }] };
      const current = { ...match, category: { slug: query.category } };
      const others = { ...match, category: { slug: { not: query.category } } };
      const options = { select: productListSelect, orderBy: this.orderBy(query.sort),
        skip: (query.page - 1) * query.limit, take: query.limit };
      // Independent pages keep both groups visible in large categories.
      const currentItems = await db.product.findMany({ ...options, where: current });
      const otherItems = await db.product.findMany({ ...options, where: others });
      const currentTotal = await db.product.count({ where: current });
      const otherTotal = await db.product.count({ where: others });
      return { items: [...currentItems, ...otherItems].map(customerProduct), total: currentTotal + otherTotal,
        page: query.page, limit: query.limit, pages: Math.ceil(Math.max(currentTotal, otherTotal) / query.limit),
        currentCategory: category, groupTotals: { current: currentTotal, others: otherTotal } };
    }, { isolationLevel: 'RepeatableRead' });
  }

  private orderBy(sort: ProductSort): Prisma.ProductOrderByWithRelationInput[] {
    if (sort === 'price_asc') return [{ price: 'asc' }, { name: 'asc' }, { id: 'asc' }];
    if (sort === 'price_desc') return [{ price: 'desc' }, { name: 'asc' }, { id: 'asc' }];
    if (sort === 'newest') return [{ createdAt: 'desc' }, { name: 'asc' }, { id: 'asc' }];
    if (sort === 'name') return [{ name: 'asc' }, { id: 'asc' }];

    return [{ sort: 'asc' }, { name: 'asc' }, { id: 'asc' }];
  }
}
