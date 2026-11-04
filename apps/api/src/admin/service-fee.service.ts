import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { adminPhone } from '../auth/admin.config.js';
import { customerPrice, effectivePercent } from '../product/pricing.js';
import { assertMarkup } from '../product/markup.js';
import { productWhere } from './product-filter.js';
import { dbError } from './errors.js';
import {
  BULK_LIMIT,
  bulkResultSchema,
  type BulkPreviewInput,
  type BulkApplyInput,
  type BulkResult,
} from './service-fee.schema.js';
import {
  bulkHash,
  readBulkPreview,
  signBulkPreview,
} from './service-fee-token.js';

const select = {
  id: true,
  name: true,
  price: true,
  priceQty: true,
  unit: true,
  updatedAt: true,
  serviceMarkupPercent: true,
  serviceMarkupPercentOverride: true,
  serviceMarkupNeedsReview: true,
} satisfies Prisma.ProductSelect;
const stale = () =>
  new ConflictException({
    code: 'SERVICE_FEE_STALE',
    message:
      'Товары или настройки изменились. Обновите предварительный расчёт.',
  });

// Signed, half-up basis points of the price difference. Monetary prices still use customerPrice().
export function priceDifferenceBps(difference: number, before: number) {
  if (
    !Number.isSafeInteger(difference) ||
    !Number.isSafeInteger(before) ||
    before <= 0
  )
    throw new BadRequestException('Некорректная исходная цена товара.');
  const amount = BigInt(Math.abs(difference)),
    base = BigInt(before);
  return Math.sign(difference) * Number((amount * 10000n + base / 2n) / base);
}

@Injectable()
export class ServiceFeeService {
  constructor(private readonly db: DbService) {}
  private async actor(db: Prisma.TransactionClient, actorId: number) {
    const actor = await db.user.findUnique({
      where: { id: actorId },
      select: { role: true, phone: true },
    });
    if (
      !actor ||
      actor.role !== 'ADMIN' ||
      !actor.phone ||
      actor.phone !== adminPhone()
    )
      throw new ForbiddenException();
  }
  private async snapshot(
    db: Prisma.TransactionClient,
    input: BulkPreviewInput,
    actorId: number,
    applying = false,
  ) {
    const settings = await db.shopSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: { globalServiceMarkupPercent: true, updatedAt: true },
    });
    const percent = effectivePercent(null, settings.globalServiceMarkupPercent);
    const products = await db.product.findMany({
      where:
        input.selection.kind === 'ids'
          ? { id: { in: input.selection.ids } }
          : productWhere(input.selection.filter),
      select,
      orderBy: { id: 'asc' },
      take: BULK_LIMIT + 1,
    });
    if (products.length > BULK_LIMIT) {
      if (applying) throw stale();
      throw new BadRequestException(
        `Выберите не более ${BULK_LIMIT} товаров. Уточните фильтр.`,
      );
    }
    if (
      !products.length ||
      (input.selection.kind === 'ids' &&
        products.length !== input.selection.ids.length)
    ) {
      if (applying) throw stale();
      throw new BadRequestException(
        'Выбор пуст или часть товаров удалена. Обновите список товаров.',
      );
    }
    for (const product of products) assertMarkup(product);
    const fingerprint = bulkHash(
      JSON.stringify({ actorId, input, settings, products }),
    );
    const rows = products.map((product) => {
      const beforePrice = customerPrice(
          product.price,
          product.serviceMarkupPercent,
        ),
        afterPrice = customerPrice(product.price, percent);
      return {
        id: product.id,
        name: product.name,
        sellerPrice: product.price,
        priceQty: product.priceQty,
        unit: product.unit,
        before: {
          mode:
            product.serviceMarkupPercentOverride === null
              ? ('global' as const)
              : ('individual' as const),
          override: product.serviceMarkupPercentOverride,
          percent: product.serviceMarkupPercent,
          customerPrice: beforePrice,
          needsReview: product.serviceMarkupNeedsReview,
        },
        after: {
          mode: 'global' as const,
          override: null,
          percent,
          customerPrice: afterPrice,
          needsReview: false,
        },
        difference: afterPrice - beforePrice,
        differenceBps: priceDifferenceBps(
          afterPrice - beforePrice,
          beforePrice,
        ),
        changed:
          product.serviceMarkupPercentOverride !== null ||
          product.serviceMarkupNeedsReview ||
          product.serviceMarkupPercent !== percent,
      };
    });
    const beforePrice = rows.reduce(
        (sum, row) => sum + row.before.customerPrice,
        0,
      ),
      afterPrice = rows.reduce((sum, row) => sum + row.after.customerPrice, 0);
    return {
      fingerprint,
      rows,
      globalPercent: percent,
      count: rows.length,
      changedCount: rows.filter((row) => row.changed).length,
      totals: {
        beforePrice,
        afterPrice,
        difference: afterPrice - beforePrice,
        differenceBps: priceDifferenceBps(
          afterPrice - beforePrice,
          beforePrice,
        ),
      },
    };
  }
  preview(input: BulkPreviewInput, actorId: number) {
    return this.db
      .$transaction(
        async (db) => {
          await db.$executeRaw`SET TRANSACTION READ ONLY`;
          await this.actor(db, actorId);
          const { fingerprint, ...preview } = await this.snapshot(
            db,
            input,
            actorId,
          );
          const expiresAt = Date.now() + 10 * 60 * 1000;
          const previewToken = signBulkPreview({
            ...input,
            version: 1,
            actorId,
            nonce: randomUUID(),
            expiresAt,
            fingerprint,
          });
          return {
            ...preview,
            previewToken,
            expiresAt: new Date(expiresAt).toISOString(),
          };
        },
        { isolationLevel: 'RepeatableRead', timeout: 10000 },
      )
      .catch(dbError);
  }
  apply(input: BulkApplyInput, actorId: number) {
    return this.db
      .$transaction(
        async (db) => {
          // NOWAIT throughout: never wait through checkout's settings -> order -> product path.
          await db.$queryRaw`SELECT id FROM "User" WHERE id=${actorId} FOR SHARE NOWAIT`;
          await this.actor(db, actorId);
          const [lock] = await db.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtextextended(${'service-fee:' + input.requestId},0)) AS locked`;
          if (!lock?.locked)
            throw new ConflictException({
              code: 'SERVICE_FEE_IN_PROGRESS',
              message:
                'Операция уже выполняется. Повторите запрос с тем же requestId.',
            });
          const previewHash = bulkHash(input.previewToken);
          const existing = await db.serviceFeeBulkOperation.findUnique({
            where: { requestId: input.requestId },
          });
          if (existing) {
            if (existing.actorId !== actorId) throw new ForbiddenException();
            if (existing.previewHash !== previewHash)
              throw new ConflictException(
                'requestId уже использован для другого предварительного расчёта.',
              );
            return bulkResultSchema.parse(existing.result);
          }
          const claims = readBulkPreview(input.previewToken);
          if (claims.actorId !== actorId) throw new ForbiddenException();
          if (claims.expiresAt <= Date.now()) throw stale();
          await db.$executeRaw`LOCK TABLE "Product" IN EXCLUSIVE MODE NOWAIT`;
          await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id=1 FOR UPDATE NOWAIT`;
          const snapshot = await this.snapshot(
            db,
            { selection: claims.selection, mode: claims.mode },
            actorId,
            true,
          );
          if (
            snapshot.fingerprint !== claims.fingerprint ||
            claims.expiresAt <= Date.now()
          )
            throw stale();
          const changed = snapshot.rows.filter((row) => row.changed);
          if (changed.length) {
            const updated = await db.product.updateMany({
              where: { id: { in: changed.map((row) => row.id) } },
              data: {
                serviceMarkupPercentOverride: null,
                serviceMarkupNeedsReview: false,
                serviceMarkupPercent: snapshot.globalPercent,
              },
            });
            if (updated.count !== changed.length) throw stale();
            await db.adminAudit.createMany({
              data: changed.map((row) => ({
                actorId,
                action: 'PRODUCT_MARKUP_CHANGED',
                entity: 'PRODUCT',
                entityId: String(row.id),
                oldValue: {
                  serviceMarkupPercentOverride: row.before.override,
                  serviceMarkupPercent: row.before.percent,
                  serviceMarkupNeedsReview: row.before.needsReview,
                  sellerPrice: row.sellerPrice,
                  customerPrice: row.before.customerPrice,
                  priceQty: row.priceQty,
                  unit: row.unit,
                },
                newValue: {
                  requestId: input.requestId,
                  serviceMarkupPercentOverride: null,
                  serviceMarkupPercent: snapshot.globalPercent,
                  serviceMarkupNeedsReview: false,
                  sellerPrice: row.sellerPrice,
                  customerPrice: row.after.customerPrice,
                  priceQty: row.priceQty,
                  unit: row.unit,
                },
              })),
            });
          }
          const result: BulkResult = {
            requestId: input.requestId,
            count: snapshot.count,
            changedCount: changed.length,
            skippedCount: snapshot.count - changed.length,
            globalPercent: snapshot.globalPercent,
            appliedAt: new Date().toISOString(),
            productIds: snapshot.rows.map((row) => row.id),
          };
          await db.serviceFeeBulkOperation.create({
            data: { requestId: input.requestId, actorId, previewHash, result },
          });
          return result;
        },
        { maxWait: 1000, timeout: 15000 },
      )
      .catch(dbError);
  }
}
