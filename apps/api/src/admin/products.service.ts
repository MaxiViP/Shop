import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { lockOwner, ownerProductWhere } from '../auth/permissions.js';
import { DbService } from '../db/db.service.js';
import type { Prisma, SettlementMode } from '../db/gen/client.js';
import type { ProductInput, ProductQuery } from './schema.js';
import { dbError } from './errors.js';
import { ImagesService } from './images.service.js';
import { quantityErrors, type ProductQuantity } from '../order/assembly.js';
import { priceBreakdown } from '../product/pricing.js';
import { hitActive, type HitProduct } from '../product/badges.js';
import { saleErrors, saleTermsChanged, type Sale } from '../product/sale.js';

function adminProduct<T extends { price: number; serviceMarkupPercent?: number } & HitProduct>(product: T) {
  return { ...product, autoHit: product.isHit === true, isHit: hitActive(product), ...priceBreakdown(product.price, product.serviceMarkupPercent) };
}

function validateQuantity(product: ProductQuantity & Sale & { priceQty: number }) {
  const errors = Object.values({ ...quantityErrors(product), ...saleErrors(product) });
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
  private async ownerScope(db: Prisma.TransactionClient, userId: number, data: Partial<ProductInput>) {
    await lockOwner(db, userId);
    if (data.marketPointId !== undefined && (!data.marketPointId || !await db.marketPointOwner.findUnique({
      where: { userId_marketPointId: { userId, marketPointId: data.marketPointId } },
    }))) throw new NotFoundException('Точка не найдена');
    if (data.categoryId && !await db.category.findFirst({ where: { id: data.categoryId, active: true } }))
      throw new BadRequestException('Категория недоступна');
  }
  async list(query: ProductQuery, ownerId?: number) {
    const { page, limit, search, category, active, settlementMode, marketPoint, priceStatus, hitMode, seasonTemplateId } = query;
    const where: Prisma.ProductWhereInput = {
      ...(ownerId ? ownerProductWhere(ownerId) : {}),
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
      this.db.product.count({ where: { settlementMode: 'UNSET', ...(ownerId ? ownerProductWhere(ownerId) : {}) } }),
    ]);
    return { items: items.map(adminProduct), total, unsetCount, page, limit, pages: Math.ceil(total / limit) };
  }
  async get(id: number, ownerId?: number) {
    const product = await this.db.product.findUnique({
      where: { id, ...(ownerId ? ownerProductWhere(ownerId) : {}) },
      include,
    });
    if (!product) throw new NotFoundException('Товар не найден');
    return adminProduct(product);
  }
  pricing(price: number, percent?: number) { return priceBreakdown(price, percent); }
  async create(data: ProductInput, actorId?: number, ownerId?: number) {
    const { saleChangeConfirmed: _confirmed, ...fields } = data;
    data = fields;
    validateQuantity(data);
    validateSeason(data);
    const values = settlement(data.settlementMode, data.basePrice);
    try {
      return await this.db.$transaction(async (db) => {
        if (ownerId) await this.ownerScope(db, ownerId, data);
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
  async update(id: number, data: Partial<ProductInput>, actorId?: number, ownerId?: number) {
    const { saleChangeConfirmed, ...fields } = data;
    data = fields;
    try {
      return await this.db.$transaction(
        async (db) => {
          if (ownerId) await this.ownerScope(db, ownerId, data);
          const current = await db.product.findUnique({ where: { id, ...(ownerId ? ownerProductWhere(ownerId) : {}) } });
          if (!current) throw new NotFoundException('Товар не найден');
          if (saleTermsChanged(current, { ...current, ...data }) && !saleChangeConfirmed)
            throw new BadRequestException('Подтвердите изменение условий продажи и проверьте цену за новую единицу.');
          validateQuantity({ ...current, ...data });
          validateSeason({ ...current, ...data });
          const season = await this.season(db, data, current);
          const before = { settlementMode: current.settlementMode, basePrice: current.basePrice };
          const after = settlement(data.settlementMode ?? current.settlementMode,
            data.basePrice === undefined ? current.basePrice : data.basePrice);
          const changed = before.settlementMode !== after.settlementMode || before.basePrice !== after.basePrice;
          const product = await db.product.update({ where: { id },
            data: { ...data, ...after, ...season }, include });
          if (actorId && data.serviceMarkupPercent !== undefined && data.serviceMarkupPercent !== current.serviceMarkupPercent)
            await db.adminAudit.create({ data: { actorId, action: 'PRODUCT_MARKUP_CHANGED', entity: 'PRODUCT', entityId: String(id),
              oldValue: current.serviceMarkupPercent, newValue: data.serviceMarkupPercent } });
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
