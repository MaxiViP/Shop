import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../src/db/gen/client.js';
import {
  bylinkinoIdentity,
  inputFiles,
  money,
  normalize,
  storeSchema,
  type Research,
} from './input.js';

const reviewSchema = z.strictObject({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']),
  marketPointId: z.number().int().positive().nullable(),
  productId: z.number().int().positive().nullable(),
  confirmedSku: z.string().min(1).nullable(),
  notes: z.string().nullable(),
  reviewedOn: z.iso.date().nullable(),
});
const referenceSchema = z
  .strictObject({
    amountKopecks: money,
    currency: z.literal('RUB'),
    unit: z.literal('GRAM'),
    priceQty: z.number().int().positive(),
    sourceQuantity: z.number().int().positive(),
    sourceUnit: z.enum(['g', 'kg']),
    sourceUnitText: z.string(),
    scope: z.literal('MOSCOW_OFFICIAL_ONLINE_CATALOG_REFERENCE'),
    checkedOn: z.iso.date(),
    productUrl: z.url(),
    observedAtUrl: z.url(),
    sourceText: z.string(),
  })
  .refine(
    (value) =>
      value.priceQty ===
      value.sourceQuantity * (value.sourceUnit === 'kg' ? 1000 : 1),
    {
      path: ['priceQty'],
      message: 'Масса ценовой базы не соответствует исходной единице',
    },
  );
const productSourceSchema = z.strictObject({
  supplierKey: z.enum(['myasberry', 'bylinkino']),
  sourceItemId: z.string().nullable(),
  name: z.string().min(1),
  sourceName: z.string().min(1),
  category: z.string().min(1),
  milkType: z.string().nullable(),
  sku: z.null(),
  description: z.null(),
  stockStatus: z.literal('UNKNOWN'),
  netWeightGrams: z.null(),
  checkedOn: z.iso.date(),
  sourceUrl: z.url(),
  scope: z.enum(['ONLINE_REFERENCE', 'MANUFACTURER_ASSORTMENT']),
  displayNameCorrections: z.array(z.string()),
  referencePrice: referenceSchema.nullable(),
});
const saleSchema = z.strictObject({
  confirmedPriceKopecks: z.null(),
  unit: z.null(),
  priceQty: z.null(),
  step: z.null(),
  min: z.null(),
  portionQty: z.null(),
  markupPercent: z.null(),
  active: z.literal(false),
});
const storeDraftSchema = z.strictObject({
  key: z.string().min(1),
  source: storeSchema,
  review: reviewSchema,
  isPublished: z.literal(false),
});
const productDraftSchema = z.strictObject({
  key: z.string().min(1),
  source: productSourceSchema,
  review: reviewSchema,
  sale: saleSchema,
});
export const queueSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    datasetId: z.literal('bagrationovsky-2026-10-11'),
    customerVisible: z.literal(false),
    orderable: z.literal(false),
    readyForDatabaseImport: z.literal(false),
    evidence: z.record(z.string(), z.unknown()),
    stores: z.array(storeDraftSchema),
    products: z.array(productDraftSchema),
  })
  .superRefine((queue, ctx) => {
    for (const [field, rows] of [
      ['stores', queue.stores],
      ['products', queue.products],
    ] as const)
      if (new Set(rows.map((row) => row.key)).size !== rows.length)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Повторяющийся ключ очереди',
        });
  });
export type ImportQueue = z.infer<typeof queueSchema>;
const pendingReview = () => ({
  status: 'PENDING' as const,
  marketPointId: null,
  productId: null,
  confirmedSku: null,
  notes: null,
  reviewedOn: null,
});
const emptySale = () => ({
  confirmedPriceKopecks: null,
  unit: null,
  priceQty: null,
  step: null,
  min: null,
  portionQty: null,
  markupPercent: null,
  active: false as const,
});

const pointSelect = {
  id: true,
  slug: true,
  name: true,
  floor: true,
  unitNumber: true,
  isPublished: true,
} satisfies Prisma.MarketPointSelect;
const productSelect = {
  id: true,
  slug: true,
  name: true,
  price: true,
  priceStatus: true,
  unit: true,
  priceQty: true,
  active: true,
  marketPointId: true,
} satisfies Prisma.ProductSelect;
export interface Snapshot {
  points: Prisma.MarketPointGetPayload<{ select: typeof pointSelect }>[];
  products: Prisma.ProductGetPayload<{ select: typeof productSelect }>[];
}

export async function readSnapshot(db: PrismaClient): Promise<Snapshot> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const points = await tx.marketPoint.findMany({
        select: pointSelect,
        orderBy: { id: 'asc' },
      });
      const products = await tx.product.findMany({
        select: productSelect,
        orderBy: { id: 'asc' },
      });
      return { points, products };
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000 },
  );
}

function pointCandidates(
  name: string,
  hints: readonly string[],
  snapshot: Snapshot | null,
  floor?: number,
  pavilion?: string | null,
) {
  const pavilionKey = (value: string) =>
    normalize(value)
      .replace(/[\s-]/gu, '')
      .replaceAll('b', 'в')
      .replaceAll('p', 'п');
  return (snapshot?.points ?? [])
    .filter((point) => floor === undefined || point.floor === floor)
    .map((point) => ({
      ...point,
      evidence: [
        ...(normalize(point.name) === normalize(name) ? ['name'] : []),
        ...(pavilion &&
        point.unitNumber &&
        pavilionKey(pavilion) === pavilionKey(point.unitNumber)
          ? ['pavilion']
          : []),
        ...(hints.includes(point.slug) ? ['hypothesis'] : []),
      ],
      confirmed: false as const,
    }))
    .filter((point) => point.evidence.length > 0);
}

// Keeping the original queued evidence on a source change requires an explicit review,
// and prevents a rerun from silently discarding either evidence or manual decisions.
function mergeRows<T extends { key: string; source: unknown }>(
  incoming: readonly T[],
  previous: readonly T[],
) {
  const old = new Map(previous.map((row) => [row.key, row]));
  const changes = incoming.map((row) => ({
    key: row.key,
    action: !old.has(row.key)
      ? ('create_draft' as const)
      : JSON.stringify(old.get(row.key)?.source) !== JSON.stringify(row.source)
        ? ('review_source_change' as const)
        : ('keep_draft' as const),
  }));
  const rows = incoming.map((row) => old.get(row.key) ?? row);
  for (const row of previous)
    if (!incoming.some((current) => current.key === row.key)) {
      rows.push(row);
      changes.push({ key: row.key, action: 'review_source_change' });
    }
  return { rows, changes };
}

export function planImport(
  research: Research,
  snapshot: Snapshot | null,
  previous?: unknown,
) {
  const old = previous === undefined ? undefined : queueSchema.parse(previous);
  const stores = mergeRows<ImportQueue['stores'][number]>(
    research.stores.additionalNames.map((source) => ({
      key: `store:${source.researchKey}`,
      source,
      review: pendingReview(),
      isPublished: false,
    })),
    old?.stores ?? [],
  );
  const myasberry = research.myasberry.offers.map((row) => ({
    key: `myasberry:offer:${row.sourceItemId}`,
    source: {
      supplierKey: 'myasberry' as const,
      sourceItemId: row.sourceItemId,
      name: row.name,
      sourceName: row.sourceName,
      category: row.categoryName,
      milkType: null,
      sku: null,
      description: null,
      stockStatus: 'UNKNOWN' as const,
      netWeightGrams: null,
      checkedOn: row.observedOn,
      sourceUrl: row.sourceProductUrl,
      scope: 'ONLINE_REFERENCE' as const,
      displayNameCorrections: row.displayNameCorrections,
      referencePrice: {
        amountKopecks: row.sourcePriceKopecks,
        currency: row.currency,
        unit: 'GRAM' as const,
        priceQty: row.sourcePriceBasis.massGrams,
        sourceQuantity: row.sourcePriceBasis.quantity,
        sourceUnit: row.sourcePriceBasis.unit,
        sourceUnitText: row.sourcePriceBasis.sourceUnitText,
        scope: row.priceScope,
        checkedOn: row.observedOn,
        productUrl: row.sourceProductUrl,
        observedAtUrl: row.priceObservedAtUrl,
        sourceText: row.sourcePriceText,
      },
    },
    review: pendingReview(),
    sale: emptySale(),
  }));
  const bylinkino = research.bylinkino.items.map((row) => ({
    key: `bylinkino:assortment:${createHash('sha256').update(bylinkinoIdentity(row)).digest('hex').slice(0, 24)}`,
    source: {
      supplierKey: 'bylinkino' as const,
      sourceItemId: null,
      name: row.name,
      sourceName: row.name,
      category: row.category,
      milkType: row.milkTypeIfExplicitlyStated,
      sku: row.sku,
      description: row.description,
      stockStatus: row.stockStatus,
      netWeightGrams: row.massGrams,
      checkedOn: research.bylinkino.checkedOn,
      sourceUrl: research.bylinkino.sourceUrl,
      scope: 'MANUFACTURER_ASSORTMENT' as const,
      displayNameCorrections: [],
      referencePrice: null,
    },
    review: pendingReview(),
    sale: emptySale(),
  }));
  const products = mergeRows<ImportQueue['products'][number]>(
    [...myasberry, ...bylinkino],
    old?.products ?? [],
  );
  const queue = queueSchema.parse({
    schemaVersion: '1.0',
    datasetId: 'bagrationovsky-2026-10-11',
    customerVisible: false,
    orderable: false,
    readyForDatabaseImport: false,
    evidence: {
      inputFiles,
      checkedOn: research.stores.checkedOn,
      market: research.stores.market,
      sources: research.stores.sources,
      siteSnapshot: research.stores.siteSnapshot,
      existingPointChecks: research.stores.existingPointChecks,
      excludedAliases: research.stores.possibleAliasesExcludedFromNewShopCount,
      excludedHistoricalListings:
        research.stores.historicalOrUnconfirmedListingsExcludedFromNewShopCount,
      myasberryCaveat: research.myasberry.sourceCaveat,
      myasberryCoverage: research.myasberry.coverage,
      bylinkinoCaveat: research.bylinkino.notes,
    },
    stores: stores.rows,
    products: products.rows,
  });
  const knownPoints = research.stores.siteSnapshot.points.map((row) => {
    const matches = (snapshot?.points ?? []).filter(
      (point) =>
        point.slug === row.slug ||
        normalize(point.name) === normalize(row.name),
    );
    return {
      ...row,
      action: !snapshot
        ? 'not_checked'
        : matches.length === 1
          ? 'skip_existing'
          : 'review_snapshot_mismatch',
      candidates: matches.map((point) => ({
        id: point.id,
        slug: point.slug,
        name: point.name,
      })),
    };
  });
  const storePlans = stores.changes.map((change) => {
    const row = queue.stores.find((row) => row.key === change.key)!;
    return {
      ...change,
      name: row.source.name,
      researchKey: row.source.researchKey,
      pavilion: row.source.pavilion,
      addressEvidenceStatus: row.source.addressEvidenceStatus,
      review: row.review,
      requiresReview:
        row.review.status === 'PENDING' ||
        change.action === 'review_source_change',
      candidates: pointCandidates(
        row.source.name,
        row.source.possibleExistingPointSlugs,
        snapshot,
        row.source.floor,
        row.source.pavilion,
      ),
      incomingSource:
        change.action === 'review_source_change'
          ? (research.stores.additionalNames.find(
              (source) => `store:${source.researchKey}` === row.key,
            ) ?? null)
          : null,
      databaseMarketPointId: null,
      requiredChecks: row.source.requiredChecks,
    };
  });
  const productPlans = products.changes.map((change) => {
    const row = queue.products.find((row) => row.key === change.key)!;
    const duplicates = research.duplicateGroups.find(
      (group) =>
        row.source.supplierKey === 'myasberry' &&
        group.sourceItemIds.includes(row.source.sourceItemId ?? ''),
    );
    return {
      ...change,
      name: row.source.name,
      supplierKey: row.source.supplierKey,
      sourceItemId: row.source.sourceItemId,
      milkType: row.source.milkType,
      referencePrice: row.source.referencePrice,
      sale: row.sale,
      review: row.review,
      requiresReview:
        row.review.status !== 'REJECTED' ||
        change.action === 'review_source_change',
      duplicateSourceItemIds: duplicates?.sourceItemIds ?? [],
      incomingSource:
        change.action === 'review_source_change'
          ? ([...myasberry, ...bylinkino].find(
              (incoming) => incoming.key === row.key,
            )?.source ?? null)
          : null,
      candidates: (snapshot?.products ?? []).filter(
        (current) => normalize(current.name) === normalize(row.source.name),
      ),
      linkedProduct:
        snapshot?.products.find(
          (current) => current.id === row.review.productId,
        ) ?? null,
      databaseMarketPointId: null,
      databaseProductId: null,
      requiredChecks: [
        'Подтверждённая торговая точка',
        'SKU и вариант',
        'Цена продажи и дата прайса',
        'Единица, фасовка, шаг, минимум и порция',
        'Наличие',
        'Согласованная политика наценки',
      ],
    };
  });
  const excluded = [
    ...research.stores.possibleAliasesExcludedFromNewShopCount.map((row) => ({
      ...row,
      reason: 'UNCONFIRMED_ALIAS',
    })),
    ...research.stores.historicalOrUnconfirmedListingsExcludedFromNewShopCount.map(
      (row) => ({ ...row, reason: 'HISTORICAL_OR_UNCONFIRMED' }),
    ),
  ].map((row) => ({
    ...row,
    action: 'skip_new_store',
    candidates: pointCandidates(
      row.name,
      row.possibleExistingPointSlugs,
      snapshot,
    ),
  }));
  const totals = (
    rows: readonly { action: string; requiresReview: boolean }[],
  ) => ({
    createDrafts: rows.filter((row) => row.action === 'create_draft').length,
    keepDrafts: rows.filter((row) => row.action === 'keep_draft').length,
    changedSources: rows.filter((row) => row.action === 'review_source_change')
      .length,
    requireReview: rows.filter((row) => row.requiresReview).length,
  });
  const preview = {
    ok: true,
    databaseMatched: snapshot !== null,
    storage: 'FILE_QUEUE',
    liveDatabaseWrites: 0,
    summary: {
      stores: totals(storePlans),
      products: totals(productPlans),
      existingSnapshotPointsSkipped: knownPoints.filter(
        (row) => row.action === 'skip_existing',
      ).length,
      snapshotPointsRequiringReview: knownPoints.filter(
        (row) => row.action !== 'skip_existing',
      ).length,
      excludedNewStores: excluded.length,
      myasberryReferences: myasberry.length,
      bylinkinoUnknownPrices: bylinkino.length,
      potentialDuplicateGroups: research.duplicateGroups.length,
      mergedSourceOffers: 0,
    },
    knownPoints,
    stores: storePlans,
    products: productPlans,
    excluded,
    duplicateGroups: research.duplicateGroups,
    existingPointChecks: research.stores.existingPointChecks,
  };
  return { queue, preview };
}

export async function readQueue(file: string) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
}

export async function saveQueue(
  file: string,
  queue: ImportQueue,
  previousText: string | undefined,
) {
  const output = `${JSON.stringify(queueSchema.parse(queue), null, 2)}\n`;
  if ((await readQueue(file)) !== previousText)
    throw new Error(
      'Очередь изменена во время проверки; повторите запуск без перезаписи ручных решений.',
    );
  if (output === previousText) return false;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, output, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
  return true;
}
