import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma, SettlementMode } from '../db/gen/client.js';
import type { ProductInput, ProductQuery } from './schema.js';
import { dbError } from './errors.js';
import { ImagesService } from './images.service.js';
import { quantityErrors, type ProductQuantity } from '../order/assembly.js';

function validateQuantity(product: ProductQuantity) {
  const errors = Object.values(quantityErrors(product));
  if (errors.length) throw new BadRequestException(errors);
}

function settlement(mode: SettlementMode | undefined, basePrice: number | null | undefined) {
  const settlementMode = mode ?? 'UNSET';
  if (settlementMode === 'SHARED_MARKUP') {
    if (!Number.isSafeInteger(basePrice) || !basePrice || basePrice < 1 || basePrice > 100_000_000)
      throw new BadRequestException('Укажите базовую цену для расчёта в копейках.');
    return { settlementMode, basePrice };
  }
  return { settlementMode, basePrice: null };
}

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
    const { page, limit, search, category, active, settlementMode } = query;
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
      ...(settlementMode ? { settlementMode } : {}),
    };
    const [items, total, unsetCount] = await this.db.$transaction([
      this.db.product.findMany({
        where,
        include,
        orderBy: [{ sort: 'asc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.product.count({ where }),
      this.db.product.count({ where: { settlementMode: 'UNSET' } }),
    ]);
    return { items, total, unsetCount, page, limit, pages: Math.ceil(total / limit) };
  }
  async get(id: number) {
    const product = await this.db.product.findUnique({
      where: { id },
      include,
    });
    if (!product) throw new NotFoundException('Товар не найден');
    return product;
  }
  async create(data: ProductInput, actorId?: number) {
    validateQuantity(data);
    const values = settlement(data.settlementMode, data.basePrice);
    try {
      return await this.db.$transaction(async (db) => {
        const product = await db.product.create({ data: { ...data, ...values }, include });
        if (actorId) await db.adminAudit.create({ data: {
          actorId, action: 'PRODUCT_SETTLEMENT_CREATED', entity: 'PRODUCT',
          entityId: String(product.id), newValue: values,
        } });
        return product;
      });
    } catch (error) {
      return dbError(error);
    }
  }
  async update(id: number, data: Partial<ProductInput>, actorId?: number) {
    try {
      return await this.db.$transaction(
        async (db) => {
          const current = await db.product.findUnique({ where: { id } });
          if (!current) throw new NotFoundException('Товар не найден');
          validateQuantity({ ...current, ...data });
          const before = { settlementMode: current.settlementMode, basePrice: current.basePrice };
          const after = settlement(data.settlementMode ?? current.settlementMode,
            data.basePrice === undefined ? current.basePrice : data.basePrice);
          const changed = before.settlementMode !== after.settlementMode || before.basePrice !== after.basePrice;
          const product = await db.product.update({ where: { id },
            data: { ...data, ...after }, include });
          if (changed && actorId) await db.adminAudit.create({ data: {
            actorId, action: 'PRODUCT_SETTLEMENT_CHANGED', entity: 'PRODUCT',
            entityId: String(id), oldValue: before, newValue: after,
          } });
          return product;
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
