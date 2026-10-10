import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma, SettlementMode } from '../db/gen/client.js';
import type { ProductInput, ProductQuery } from './schema.js';
import { dbError } from './errors.js';
import { ImagesService } from './images.service.js';
import { quantityErrors, type ProductQuantity } from '../order/assembly.js';
import { priceBreakdown } from '../product/pricing.js';
import { hitActive, type HitProduct } from '../product/badges.js';

function adminProduct<T extends { price: number } & HitProduct>(product: T) {
  return { ...product, autoHit: product.isHit === true, isHit: hitActive(product), ...priceBreakdown(product.price) };
}

function validateQuantity(product: ProductQuantity) {
  const errors = Object.values(quantityErrors(product));
  if (errors.length) throw new BadRequestException(errors);
}

function validateSeason(product: { seasonalStartsAt?: string | Date | null; seasonalEndsAt?: string | Date | null }) {
  if (product.seasonalStartsAt && product.seasonalEndsAt &&
    new Date(product.seasonalEndsAt) <= new Date(product.seasonalStartsAt))
    throw new BadRequestException('Окончание сезонности должно быть позже начала.');
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
  seasonTemplate: true,
  marketPoint: { select: { id: true, slug: true, name: true } },
  images: { orderBy: [{ sort: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ProductInclude;
@Injectable()
export class AdminProductsService {
  constructor(
    private readonly db: DbService,
    private readonly images: ImagesService,
  ) {}
  private async season(db: Prisma.TransactionClient, data: Partial<ProductInput>, current?: { seasonalMode: ProductInput['seasonalMode']; seasonTemplateId: number | null }) {
    const seasonalMode = data.seasonalMode ?? (data.isSeasonal === undefined ? current?.seasonalMode ?? 'OFF' : data.isSeasonal ? 'MANUAL' : 'OFF');
    const seasonTemplateId = data.seasonTemplateId === undefined ? current?.seasonTemplateId ?? null : data.seasonTemplateId;
    if (seasonalMode === 'AUTO' && seasonTemplateId === null) throw new BadRequestException('Выберите шаблон сезонности.');
    if (seasonTemplateId !== null && !await db.seasonTemplate.findUnique({ where: { id: seasonTemplateId } }))
      throw new BadRequestException('Шаблон сезонности не найден.');
    return { seasonalMode, seasonTemplateId, isSeasonal: seasonalMode === 'MANUAL' };
  }
  async list(query: ProductQuery) {
    const { page, limit, search, category, active, settlementMode, marketPoint, priceStatus, hitMode, seasonTemplateId } = query;
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
      ...(marketPoint ? { marketPointId: marketPoint } : {}),
      ...(priceStatus ? { priceStatus } : {}),
      ...(hitMode ? { hitMode } : {}),
      ...(seasonTemplateId ? { seasonTemplateId } : {}),
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
    return { items: items.map(adminProduct), total, unsetCount, page, limit, pages: Math.ceil(total / limit) };
  }
  async get(id: number) {
    const product = await this.db.product.findUnique({
      where: { id },
      include,
    });
    if (!product) throw new NotFoundException('Товар не найден');
    return adminProduct(product);
  }
  pricing(price: number) { return priceBreakdown(price); }
  async create(data: ProductInput, actorId?: number) {
    validateQuantity(data);
    validateSeason(data);
    const values = settlement(data.settlementMode, data.basePrice);
    try {
      return await this.db.$transaction(async (db) => {
        const season = await this.season(db, data);
        const product = await db.product.create({ data: { ...data, ...values, ...season }, include });
        if (actorId) await db.adminAudit.create({ data: {
          actorId, action: 'PRODUCT_SETTLEMENT_CREATED', entity: 'PRODUCT',
          entityId: String(product.id), newValue: values,
        } });
        return adminProduct(product);
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
          validateSeason({ ...current, ...data });
          const season = await this.season(db, data, current);
          const before = { settlementMode: current.settlementMode, basePrice: current.basePrice };
          const after = settlement(data.settlementMode ?? current.settlementMode,
            data.basePrice === undefined ? current.basePrice : data.basePrice);
          const changed = before.settlementMode !== after.settlementMode || before.basePrice !== after.basePrice;
          const product = await db.product.update({ where: { id },
            data: { ...data, ...after, ...season }, include });
          if (changed && actorId) await db.adminAudit.create({ data: {
            actorId, action: 'PRODUCT_SETTLEMENT_CHANGED', entity: 'PRODUCT',
            entityId: String(id), oldValue: before, newValue: after,
          } });
          return adminProduct(product);
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
