import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

@Injectable()
export class ProductService {
  constructor(private readonly db: DbService) {}

  list(category?: string) {
    return this.db.product.findMany({
      where: {
        active: true,
        category: category ? { slug: category } : undefined,
      },

      select: {
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
      },

      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
  }

  async get(slug: string) {
    const product = await this.db.product.findFirst({
      where: {
        slug,
        active: true,
      },

      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
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
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }
}
