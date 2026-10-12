import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { marketProducts as sourceProducts } from '../market-products/2026-10-06.js';
import { marketProducts as estimatedProducts } from '../market-products/2026-10-07-estimated.js';
import { saleModel, type SaleModel } from '../../src/product/sale.js';

const root = new URL('../../../../', import.meta.url);
const report = new URL('docs/catalog-sale-audit/', root);
const readJson = async (path: string) =>
  JSON.parse(
    (await readFile(new URL(path, root), 'utf8')).replace(/^\uFEFF/, ''),
  ) as unknown;
if (process.argv.slice(2).some((arg) => arg !== '--refresh-report'))
  throw new Error(
    'Use --refresh-report only to regenerate the dated audit report',
  );
if (
  !process.argv.includes('--refresh-report') &&
  (await readFile(new URL('summary.json', report), 'utf8').then(
    () => true,
    () => false,
  ))
) {
  console.log(
    'Датированный аудит уже существует. Исходный снимок и план сохранены. Применение: catalog:sale-apply --dry-run.',
  );
  process.exit(0);
}
const evidence = z
  .object({
    sources: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        verifiedSkus: z
          .array(z.object({ slug: z.string(), name: z.string() }))
          .optional(),
      }),
    ),
  })
  .parse(await readJson('docs/catalog-sale-audit/sources.json'));
const unit = z.enum(['GRAM', 'PIECE', 'BUNCH', 'PACK']);
const fields = z.object({
  unit,
  priceQty: z.number().int().positive(),
  min: z.number().int().positive(),
  step: z.number().int().positive(),
  portionQty: z.number().int().positive(),
});
const product = fields.extend({
  id: z.number().int().positive().optional(),
  slug: z.string(),
  name: z.string(),
  categorySlug: z.string(),
  marketPointSlug: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  sourceCheckedAt: z.string().nullable().optional(),
  active: z.boolean().optional(),
  price: z.number().int().positive().optional(),
  sellerPrice: z.number().int().positive().optional(),
  priceStatus: z.string().optional(),
  updatedAt: z.string().optional(),
});
type Product = z.infer<typeof product>;
const database = z
  .object({
    available: z.boolean(),
    checkedAt: z.string(),
    products: z.array(product).optional(),
  })
  .parse(await readJson('docs/catalog-sale-audit/database.json'));
const applied = z
  .object({
    changes: z.array(
      z.object({ productId: z.number().int(), action: z.string() }),
    ),
  })
  .nullable()
  .parse(
    await readFile(new URL('apply.json', report), 'utf8').then(
      (content) => JSON.parse(content) as unknown,
      () => null,
    ),
  );
const appliedIds = new Set(
  applied?.changes
    .filter((change) => change.action === 'APPLIED')
    .map((change) => change.productId),
);
const starter = z
  .object({ products: z.array(product) })
  .parse(
    await readJson(
      'apps/api/data/catalog-drafts/moscow-market-2026-10-11/catalog-all.json',
    ),
  );
const queue = z
  .object({
    products: z.array(
      z.object({
        key: z.string(),
        source: z.object({
          name: z.string(),
          category: z.string(),
          supplierKey: z.string(),
          sourceUrl: z.string(),
          checkedOn: z.string(),
        }),
      }),
    ),
  })
  .parse(
    await readJson(
      'apps/api/data/imports/bagrationovsky-2026-10-11/prepared/import-queue.json',
    ),
  );
const excluded = z
  .object({
    items: z.array(z.object({ name: z.string(), reason: z.string() })),
  })
  .parse(
    await readJson(
      'apps/api/data/catalog-drafts/moscow-market-2026-10-11/excluded-seasonal.json',
    ),
  );
const photos = z
  .object({ products: z.array(z.object({ slug: z.string() })) })
  .parse(
    await readJson('apps/api/data/product-photos/2026-10-07/manifest.json'),
  );
const dbBySlug = new Map(
  (database.products ?? []).map((row) => [row.slug, row]),
);
const importedAliases = z
  .object({
    products: z.array(
      z.object({
        proposedSlug: z.string(),
        slug: z.string(),
        id: z.number().int(),
      }),
    ),
  })
  .parse(
    await readJson(
      'apps/api/data/catalog-drafts/moscow-market-2026-10-11/reports/apply.json',
    ),
  );
const actualSlug = (slug: string) =>
  importedAliases.products.find((row) => row.proposedSlug === slug)?.slug ??
  slug;
const wholeSlugs = new Set([
  'myasoed-rabbit',
  'myasoed-beef-tongue',
  'halal-meat-lamb-leg',
  'halal-meat-lamb-shoulder',
  'halal-meat-halal-chicken',
  'goldfish-live-carp',
  'goldfish-chilled-trout',
  'goldfish-chilled-dorado',
  'goldfish-chilled-seabass',
  'goldfish-frozen-mackerel',
  'goldfish-salted-herring',
  'goldfish-hot-smoked-mackerel',
  'romanovskoe-osetrovoe-hozyaystvo-chilled-sturgeon',
  'romanovskoe-osetrovoe-hozyaystvo-chilled-sterlet',
  ...[
    'cabbage-white',
    'cabbage-red',
    'cabbage-peking',
    'cabbage-savoy',
    'cauliflower',
    'broccoli',
    'pumpkin-muscat',
    'pomelo',
    'papaya',
    'watermelon',
    'melon',
  ].map((key) => `vegetables-fruits-east-${key}`),
]);
const cutSlugs = new Set([
  'myasoed-beef-shoulder',
  'myasoed-beef-tenderloin',
  'myasoed-pork-neck',
  'myasoed-pork-tenderloin',
  'myasoed-pork-ribs',
  'myasoed-beef-liver',
  'halal-meat-beef-liver',
  'halal-meat-beef-shoulder',
  'halal-meat-beef-ribs',
  'halal-meat-lamb-ribs',
  'goldfish-salmon-fillet',
  'goldfish-cod-fillet',
  'goldfish-halibut',
  'goldfish-salmon-steak',
]);
const ambiguousIds = new Set([
  7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22,
]);
const categoryEvidence: Record<string, string[]> = {
  vegetables: ['vegetables'],
  fruits: ['fruits'],
  greens: ['greens'],
  berries: ['berries', 'blueberries'],
  meat: ['meat', 'bone-cut', 'lamb', 'rabbit', 'liver', 'heart'],
  myaso: ['meat', 'bone-cut'],
  poultry: ['duck', 'meat'],
  fish: ['dorado'],
  seafood: ['seafood'],
  cheese: ['cheese'],
  sausages: ['sausage'],
  pickles: ['pickles', 'pickle-jar'],
  'nuts-dried-fruits': ['nuts', 'dried-fruits'],
  dairy: ['dairy'],
  'tea-coffee': ['tea-loose', 'coffee'],
  'sweets-biscuits': ['sweets-loose', 'baked-pack'],
  bakery: ['bakery', 'baked-pack'],
  honey: ['honey'],
};

function row(value: Product, source: string, scope: string) {
  const original = fields.parse(value);
  const isCezoni = value.slug.startsWith('cezoni-market-');
  const isCaviar = value.slug.startsWith(
    'romanovskoe-osetrovoe-hozyaystvo-black-caviar-',
  );
  const confirmedPack = Boolean(
    isCezoni &&
    evidence.sources
      .find((source) => source.id === 'cezoni')
      ?.verifiedSkus?.some(
        (sku) => sku.slug === value.slug && sku.name === value.name,
      ),
  );
  const whole = wholeSlugs.has(value.slug);
  const cut = cutSlugs.has(value.slug);
  const suspected = Boolean(value.id && ambiguousIds.has(value.id));
  const model = saleModel({ unit: value.unit });
  const proposedModel: SaleModel =
    confirmedPack || isCaviar
      ? 'PACK'
      : whole
        ? 'WHOLE_VARIABLE_WEIGHT'
        : cut
          ? 'CUT_TO_WEIGHT'
          : model;
  const next = confirmedPack
    ? {
        unit: 'PACK' as const,
        priceQty: 1,
        min: 1,
        step: 1,
        portionQty: 1,
        saleModel: 'PACK' as const,
        priceUnit: 'PACK' as const,
      }
    : { ...original, saleModel: model, priceUnit: value.unit };
  const errors: string[] = [];
  if (confirmedPack && value.unit === 'PIECE')
    errors.push('CONFIRMED_PACK_LABELED_PIECE');
  if (
    value.min % value.step !== 0 ||
    value.portionQty % value.step !== 0 ||
    value.portionQty < value.min
  )
    errors.push('INVALID_QUANTITY_GRID');
  if (whole) errors.push('REVIEW_INDIVISIBLE_WEIGHT');
  if (cut) errors.push('CUTTING_UNCONFIRMED');
  if (suspected)
    errors.push(
      value.id === 7
        ? 'REVIEW_ONE_GRAM_STEP_AND_CUTTING'
        : 'PRICE_BASE_OR_PACK_UNCONFIRMED',
    );
  if (value.unit === 'BUNCH') errors.push('BUNCH_WEIGHT_UNKNOWN_NO_CONVERSION');
  if (!confirmedPack && value.unit === 'PACK')
    errors.push('SELLER_PACK_UNCONFIRMED');
  const exactKnown =
    confirmedPack &&
    [value.priceQty, value.min, value.step, value.portionQty].every(
      (qty) => qty === 1,
    );
  return {
    key: `${scope}:${value.slug}`,
    scope,
    source,
    productId: dbBySlug.get(actualSlug(value.slug))?.id ?? value.id ?? null,
    slug: value.slug,
    actualProductSlug: dbBySlug.get(actualSlug(value.slug))?.slug ?? null,
    name: value.name,
    category: value.categorySlug,
    marketPoint: value.marketPointSlug ?? null,
    active: value.active ?? null,
    old: original,
    currentModel: model,
    chosenModel: exactKnown ? 'PACK' : null,
    new: exactKnown ? next : { ...original, saleModel: null, priceUnit: null },
    sellerPriceKopecks: value.price ?? value.sellerPrice ?? null,
    priceStatus: value.priceStatus ?? null,
    recommendedModel: proposedModel,
    proposedQuantity: whole
      ? {
          unit: 'PIECE',
          priceUnit: 'GRAM',
          priceQty: value.priceQty,
          min: 1,
          step: 1,
          portionQty: 1,
          estimatedWeightGrams: null,
        }
      : null,
    status: exactKnown ? 'CONFIRMED' : 'NEEDS_SELLER_CONFIRMATION',
    confidence: exactKnown
      ? 'HIGH'
      : whole || cut || suspected
        ? 'LOW'
        : 'MEDIUM',
    reason: exactKnown
      ? 'CONFIRMED_PACK_SKU_SAME_COUNT_AND_PRICE_BASE'
      : whole
        ? 'WHOLE_OR_CUT_MUST_BE_CONFIRMED'
        : cut
          ? 'SELLER_MUST_CONFIRM_CUTTING'
          : suspected
            ? 'EXISTING_PRICE_BASE_CANNOT_BE_CONVERTED_WITHOUT_EVIDENCE'
            : 'EXISTING_MODEL_RETAINED_SELLER_TERMS_NOT_VERIFIED',
    evidenceIds: isCezoni
      ? ['cezoni']
      : isCaviar
        ? ['romanovo']
        : value.slug.startsWith('grand-bazar-')
          ? ['grand-bazar']
          : (categoryEvidence[value.categorySlug] ?? []),
    sourceUrls: (isCezoni
      ? ['cezoni']
      : isCaviar
        ? ['romanovo']
        : value.slug.startsWith('grand-bazar-')
          ? ['grand-bazar']
          : (categoryEvidence[value.categorySlug] ?? [])
    ).map((id) => evidence.sources.find((source) => source.id === id)!.url),
    exactSellerSkuRechecked: exactKnown,
    originalSourceUrl: value.sourceUrl ?? null,
    originalSourceCheckedAt: value.sourceCheckedAt ?? null,
    checkedOn: '2026-10-12',
    sellerConfirmationRequired: !exactKnown,
    divisible: exactKnown ? false : null,
    packaging: exactKnown ? 'FIXED_CONSUMER_PACK' : null,
    packWeightGrams: null,
    priceConversion: exactKnown
      ? 'IDENTITY_ONE_ITEM_IS_ONE_EXISTING_PACK_PRICE_UNCHANGED'
      : 'NONE',
    weighing: whole
      ? 'REQUIRED_IF_WHOLE_CONFIRMED'
      : value.unit === 'GRAM'
        ? 'ACTUAL_GRAMS'
        : 'SELLER_CONFIRMATION',
    weightDeviation: whole
      ? 'NO_PERCENT_TOLERANCE_FOR_UNKNOWN_WHOLE_WEIGHT'
      : value.unit === 'GRAM'
        ? 'ORDER_TOLERANCE_WITH_CUSTOMER_APPROVAL'
        : null,
    sellerQuestions: exactKnown
      ? []
      : whole || cut
        ? [
            'Целый экземпляр, готовый кусок или допускается отделить заказанный вес?',
            'Цена действительно за указанные граммы?',
            'Есть ли подтвержденные ограничения, фасовка и минимум?',
          ]
        : [
            'Цена за штуку, пучок, упаковку или килограмм?',
            'Какая фасовка и минимально исполнимый заказ?',
            'Можно ли разделять продукт?',
          ],
    errors,
    changedFields:
      exactKnown && value.unit === 'PIECE'
        ? ['unit', 'saleModel', 'priceUnit']
        : [],
    application:
      exactKnown && value.unit === 'PIECE'
        ? scope.startsWith('DATABASE_') && value.id && appliedIds.has(value.id)
          ? 'APPLIED_LOCAL'
          : scope === 'SOURCE_SNAPSHOT' &&
              sourceProducts.some(
                (item) => item.slug === value.slug && item.unit === 'PACK',
              )
            ? 'APPLIED_SOURCE'
            : 'PLANNED_CONFIRMED_ONLY'
        : 'UNCHANGED',
  };
}
const entries = [
  ...(database.products ?? []).map((value) =>
    row(
      value,
      'docs/catalog-sale-audit/database.json',
      value.active ? 'DATABASE_ACTIVE' : 'DATABASE_INACTIVE',
    ),
  ),
  // Original 2026-10-06 snapshot used PIECE for all 40 packaged SKUs.
  ...sourceProducts.map((value) =>
    row(
      product.parse({ ...value, unit: 'PIECE' }),
      'apps/api/data/market-products/2026-10-06.ts',
      'SOURCE_SNAPSHOT',
    ),
  ),
  ...estimatedProducts.map((value) =>
    row(
      product.parse(value),
      'apps/api/data/market-products/2026-10-07-estimated.ts',
      'UNIMPORTED_SELLER_DRAFT',
    ),
  ),
  ...starter.products.map((value) =>
    row(
      value,
      'apps/api/data/catalog-drafts/moscow-market-2026-10-11/catalog-all.json',
      'STARTER_DRAFT',
    ),
  ),
];
// Seed is parsed from its six actual literal product records, not counted as six new DB products.
const seedText = await readFile(
  new URL('apps/api/prisma/seed.ts', root),
  'utf8',
);
for (const match of seedText.matchAll(
  /name: '([^']+)',\s+slug: '([^']+)',\s+price: (\d+),\s+priceQty: (\d+),\s+unit: Unit\.(GRAM|PIECE|BUNCH|PACK),\s+step: (\d+),\s+min: (\d+),\s+category: '([^']+)'/g,
))
  entries.push(
    row(
      product.parse({
        name: match[1],
        slug: match[2],
        price: Number(match[3]),
        priceQty: Number(match[4]),
        unit: match[5],
        step: Number(match[6]),
        min: Number(match[7]),
        portionQty: Number(match[7]),
        categorySlug: match[8],
      }),
      'apps/api/prisma/seed.ts',
      'SEED',
    ),
  );
const research = queue.products.map((value) => ({
  key: value.key,
  scope: 'RESEARCH_QUEUE',
  source:
    'apps/api/data/imports/bagrationovsky-2026-10-11/prepared/import-queue.json',
  productId: null,
  slug: null,
  name: value.source.name,
  category: value.source.category,
  marketPoint: value.source.supplierKey,
  old: { unit: null, priceQty: null, min: null, step: null, portionQty: null },
  chosenModel: null,
  new: { unit: null, priceQty: null, min: null, step: null, portionQty: null },
  recommendedModel: null,
  status: 'NEEDS_SELLER_CONFIRMATION',
  confidence: 'LOW',
  sellerConfirmationRequired: true,
  reason: 'ONLINE_REFERENCE_OR_ASSORTMENT_NOT_ORDERABLE_SKU',
  originalSourceUrl: value.source.sourceUrl,
  originalSourceCheckedAt: value.source.checkedOn,
  checkedOn: '2026-10-12',
  externallyRechecked: false,
  changedFields: [],
  application: 'NOT_IMPORTED',
  sellerQuestions: [
    'Подтвердить точку, SKU, единицу, фасовку, цену и наличие.',
  ],
}));
const countBy = (values: readonly { category: string }[]) => {
  const counts: Record<string, number> = {};
  for (const value of values)
    counts[value.category] = (counts[value.category] ?? 0) + 1;
  return counts;
};
const scopes = [...new Set(entries.map((value) => value.scope))].map(
  (scope) => ({
    scope,
    count: entries.filter((value) => value.scope === scope).length,
    categories: countBy(entries.filter((value) => value.scope === scope)),
  }),
);
const dbEntries = entries.filter((value) =>
  value.scope.startsWith('DATABASE_'),
);
if (
  dbEntries.length !== (database.products?.length ?? 0) ||
  new Set(dbEntries.map((value) => value.productId)).size !== dbEntries.length
)
  throw new Error('Incomplete DB inventory');
const patches = dbEntries
  .filter((value) => value.changedFields.length > 0)
  .map((value) => {
    const current = database.products!.find((p) => p.id === value.productId)!;
    return {
      productId: current.id!,
      slug: current.slug,
      name: current.name,
      expectedUpdatedAt: current.updatedAt!,
      sourceUrl: current.sourceUrl,
      before: { ...value.old, saleModel: null, priceUnit: null },
      after: value.new,
      status: value.status,
      evidenceIds: value.evidenceIds,
    };
  });
const summary = {
  checkedOn: '2026-10-12',
  databaseAvailable: database.available,
  databaseCheckedAt: database.checkedAt,
  databaseTotal: dbEntries.length,
  databaseActive: dbEntries.filter((value) => value.scope === 'DATABASE_ACTIVE')
    .length,
  databaseInactive: dbEntries.filter(
    (value) => value.scope === 'DATABASE_INACTIVE',
  ).length,
  uniqueCatalogCandidates: new Set(
    entries.map((value) => value.actualProductSlug ?? value.slug),
  ).size,
  catalogReportRows: entries.length,
  researchReportRows: research.length,
  databaseCategories: countBy(dbEntries),
  scopes,
  researchQueue: {
    count: research.length,
    categories: countBy(research),
    imported: false,
  },
  confirmedDatabaseUnitErrors: patches.length,
  appliedDatabaseChanges: dbEntries.filter(
    (value) => value.application === 'APPLIED_LOCAL',
  ).length,
  appliedSourceChanges: entries.filter(
    (value) => value.application === 'APPLIED_SOURCE',
  ).length,
  confirmedQuantityGridErrors: dbEntries.filter((value) =>
    value.errors.includes('INVALID_QUANTITY_GRID'),
  ).length,
  suspectedDatabaseRows: dbEntries.filter(
    (value) => value.errors.length && value.sellerConfirmationRequired,
  ).length,
  wholeCandidates: entries
    .filter((value) => value.recommendedModel === 'WHOLE_VARIABLE_WEIGHT')
    .map((value) => ({
      scope: value.scope,
      slug: value.slug,
      name: value.name,
      productId: value.productId,
    })),
  uniqueWholeCandidateCount: new Set(
    entries
      .filter((value) => value.recommendedModel === 'WHOLE_VARIABLE_WEIGHT')
      .map((value) => value.actualProductSlug ?? value.slug),
  ).size,
  sellerConfirmationDatabaseCount: dbEntries.filter(
    (value) => value.sellerConfirmationRequired,
  ).length,
  excludedSeasonalSuggestions: excluded.items.length,
  photoManifestReferences: photos.products.length,
  photoReferencesMissingFromSellerDatasets: photos.products.filter(
    (value) =>
      !estimatedProducts.some((p) => p.slug === value.slug) &&
      !sourceProducts.some((p) => p.slug === value.slug),
  ),
  databaseFullInventoryCompleted: database.available,
  productionInventoryCompleted: false,
};
const fileChecksums: Record<string, string> = {};
for (const file of [
  'apps/api/data/market-products/types.ts',
  'apps/api/data/market-products/2026-10-06.ts',
  'apps/api/data/market-products/2026-10-07-estimated.ts',
  'apps/api/prisma/seed.ts',
  'apps/api/data/catalog-drafts/moscow-market-2026-10-11/shop-import.json',
  'apps/api/data/imports/bagrationovsky-2026-10-11/prepared/import-queue.json',
])
  fileChecksums[file] = createHash('sha256')
    .update(await readFile(new URL(file, root)))
    .digest('hex');
const save = (name: string, value: unknown) =>
  writeFile(new URL(name, report), JSON.stringify(value, null, 2) + '\n');
await save('products.json', {
  summary,
  products: entries,
  researchProducts: research,
  excludedSuggestions: excluded.items,
  duplicateFileCopies: [
    '01-vegetables.json',
    '02-fruits.json',
    '03-greens.json',
    '04-berries.json',
    'shop-import.json',
    'photo-briefs.json',
    'photo-map.json',
    'price-selection.json',
    'myasberry-moscow-online-prices-2026-10-11.json',
    'bylinkino-assortment-without-prices-2026-10-11.json',
  ],
  fileChecksums,
});
await save('plan.json', {
  version: 1,
  localOnly: true,
  databaseCheckedAt: database.checkedAt,
  patches,
});
await save('summary.json', summary);
await save('seller-review.json', {
  products: [
    ...entries.filter((value) => value.sellerConfirmationRequired),
    ...research,
  ],
});
const files = await readdir(new URL('apps/api/data/', root));
await save('source-index.json', {
  dataDirectories: files,
  points: [
    'docs/market-map.md',
    'apps/api/prisma/migrations/20261006120000_market_map/migration.sql',
    'apps/api/data/imports/bagrationovsky-2026-10-11/bagrationovsky-stores-2026-10-11.json',
  ],
  referenceOnly: [
    'apps/api/data/product-photos/',
    'product-photo-slugs.json',
    'product-photo-slugs-copy.json',
  ],
  excluded: 'Test fixtures are not catalog products.',
});
console.log(
  JSON.stringify(
    {
      database: summary.databaseTotal,
      scopes: scopes.map(({ scope, count }) => ({ scope, count })),
      research: research.length,
      confirmedPatches: patches.length,
      wholeCandidates: summary.wholeCandidates.length,
    },
    null,
    2,
  ),
);
