import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { productListSelect } from '../product/select.js';
import type { FavoriteSyncInput } from './schema.js';

@Injectable()
export class FavoriteService {
  constructor(private readonly db: DbService) {}

  async list(userId: number) {
    const favorites = await this.db.favorite.findMany({
      where: {
        userId,
        product: { active: true },
      },
      select: {
        product: { select: productListSelect },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { items: favorites.map(({ product }) => product) };
  }

  async add(userId: number, productId: number) {
    const product = await this.db.product.findFirst({
      where: { id: productId, active: true },
      select: { id: true },
    });

    if (!product) throw new NotFoundException('Товар не найден');

    await this.db.favorite.upsert({
      where: { userId_productId: { userId, productId } },
      update: {},
      create: { userId, productId },
    });

    return { ok: true };
  }

  async remove(userId: number, productId: number) {
    await this.db.favorite.deleteMany({
      where: { userId, productId },
    });

    return { ok: true };
  }

  async sync(userId: number, input: FavoriteSyncInput) {
    const productIds = [...new Set(input.productIds)];

    if (!productIds.length) return { ok: true, added: 0 };

    const products = await this.db.product.findMany({
      where: {
        id: { in: productIds },
        active: true,
      },
      select: { id: true },
    });
    if (!products.length) return { ok: true, added: 0 };

    const result = await this.db.favorite.createMany({
      data: products.map(({ id: productId }) => ({ userId, productId })),
      skipDuplicates: true,
    });

    return { ok: true, added: result.count };
  }
}
