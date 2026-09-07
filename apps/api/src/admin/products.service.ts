import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import type { ProductInput, ProductQuery } from './schema.js';
import { dbError } from './errors.js';
import { ImagesService } from './images.service.js';

const include = {
  category: true,
  images: { orderBy: [{ sort: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ProductInclude;
@Injectable()
export class AdminProductsService {
  constructor(
    private readonly db: DbService,
    private readonly images: ImagesService,
  ) {}
  async list(query: ProductQuery) {
    const { page, limit, search, category, active } = query;
    const where: Prisma.ProductWhereInput = {
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(category ? { categoryId: category } : {}),
      ...(active ? { active: active === 'true' } : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.product.findMany({
        where,
        include,
        orderBy: [{ sort: 'asc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.product.count({ where }),
    ]);
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }
  async get(id: number) {
    const product = await this.db.product.findUnique({
      where: { id },
      include,
    });
    if (!product) throw new NotFoundException('Товар не найден');
    return product;
  }
  async create(data: ProductInput) {
    try {
      return await this.db.product.create({ data, include });
    } catch (error) {
      return dbError(error);
    }
  }
  async update(id: number, data: Partial<ProductInput>) {
    try {
      return await this.db.$transaction(
        async (db) => {
          const current = await db.product.findUnique({ where: { id } });
          if (!current) throw new NotFoundException('Товар не найден');
          return db.product.update({ where: { id }, data, include });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      return dbError(error);
    }
  }
  async remove(id: number) {
    let product;
    try {
      product = await this.db.product.delete({
        where: { id },
        include: { images: true },
      });
    } catch (error) {
      return dbError(error);
    }
    for (const image of product.images) await this.images.cleanup(image.url);
    return { ok: true };
  }
}
