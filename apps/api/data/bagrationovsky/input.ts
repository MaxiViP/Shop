import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const inputDirectory = new URL(
  '../imports/bagrationovsky-2026-10-11/',
  import.meta.url,
);
export const inputFiles = {
  stores: 'bagrationovsky-stores-2026-10-11.json',
  myasberry: 'myasberry-moscow-online-prices-2026-10-11.json',
  bylinkino: 'bylinkino-assortment-without-prices-2026-10-11.json',
} as const;
const text = z.string().min(1);
const count = z.number().int().nonnegative();
const date = z.iso.date();
const url = z.url({ protocol: /^https?$/ });
export const money = z.number().int().positive().max(2_147_483_647);
export const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/[«»"'().,]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
export const sourceSchema = z.object({
  id: text,
  url,
  sourceType: text,
  checkedOn: date,
  supports: text,
});
export const storeSchema = z.looseObject({
  researchKey: text,
  name: text,
  address: text,
  floor: z.number().int().positive(),
  pavilion: text.nullable(),
  addressEvidenceStatus: z.enum([
    'OFFICIAL_SELLER_ADDRESS_LIST',
    'DIRECTORY_ONLY',
  ]),
  floorAndPavilionEvidenceType: text,
  operationOnCheckedDateConfirmed: z.literal(false),
  possibleExistingPointMatchConfirmed: z.literal(false),
  possibleExistingPointSlugs: z.array(text),
  sourceIds: z.array(text).min(1),
  contacts: z.array(z.object({ phone: text, scope: text, sourceId: text })),
  requiredChecks: z.array(text),
  allowAutomaticPublish: z.literal(false),
});
const excludedSchema = z.looseObject({
  name: text,
  sourceIds: z.array(text),
  possibleExistingPointSlugs: z.array(text).default([]),
});
const storesSchema = z.looseObject({
  schemaVersion: z.literal('1.0'),
  documentType: z.literal('MARKET_RESEARCH_NOT_LIVE_CATALOG_IMPORT'),
  checkedOn: date,
  market: z.object({
    name: text,
    address: text,
    floor: z.number().int().positive(),
  }),
  summary: z.looseObject({
    existingSitePointCount: count,
    additionalNamesForVerification: count,
    onlineReferenceOfferCount: count,
  }),
  siteSnapshot: z.object({
    url,
    checkedOn: date,
    points: z.array(
      z.object({ slug: text, name: text, typeShownOnSite: text, url }),
    ),
  }),
  additionalNames: z.array(storeSchema),
  sources: z.array(sourceSchema),
  possibleAliasesExcludedFromNewShopCount: z.array(excludedSchema),
  historicalOrUnconfirmedListingsExcludedFromNewShopCount:
    z.array(excludedSchema),
  existingPointChecks: z.array(
    z.object({ slugs: z.array(text), issue: text, sourceId: text }),
  ),
  importRules: z.looseObject({
    automaticLiveImportAllowed: z.literal(false),
    unknownPriceValue: z.null(),
    neverConvertUnknownPriceToZero: z.literal(true),
    markupAppliedToSourcePrices: z.literal(false),
  }),
});
const basisSchema = z.object({
  quantity: z.number().int().positive(),
  unit: z.enum(['g', 'kg']),
  massGrams: z.number().int().positive(),
  sourceUnitText: z.enum(['г', 'гр', 'кг']),
});
const offerSchema = z.object({
  sourceItemId: z.string().regex(/^\d+$/),
  name: text,
  sourceName: text,
  categoryIndex: count,
  categoryName: text,
  sourceProductUrl: url,
  priceObservedAtUrl: url,
  observedOn: date,
  sourcePriceRubles: z.number().positive(),
  sourcePriceKopecks: money,
  currency: z.literal('RUB'),
  sourcePriceBasis: basisSchema,
  sourcePriceText: text,
  priceScope: z.literal('MOSCOW_OFFICIAL_ONLINE_CATALOG_REFERENCE'),
  retailMarketStallPriceRubles: z.null(),
  marketStallSellerConfirmed: z.literal(false),
  stockStatus: z.literal('UNKNOWN'),
  description: z.null(),
  displayNameCorrections: z.array(text),
  allowAutomaticPublishForMarketStall: z.literal(false),
});
const myasberrySchema = z.looseObject({
  schemaVersion: z.literal('1.0'),
  documentType: z.literal(
    'ONLINE_PRICE_REFERENCE_NOT_CONFIRMED_STALL_PRICELIST',
  ),
  supplierName: z.literal('МясБерри'),
  checkedOn: date,
  sourceBaseUrl: url,
  sourceCaveat: text,
  regionShownInCatalog: z.literal('Москва'),
  markupApplied: z.literal(false),
  marketStallOperationConfirmed: z.literal(false),
  coverage: z.looseObject({
    topLevelCategoriesObserved: count,
    listingPagesObserved: count,
    observedCatalogOfferCount: count,
    distinctSourceItemIdCount: count,
    distinctNormalizedNames: count,
    potentialDuplicateNameGroups: count,
    completeForPhysicalMarketStall: z.literal(false),
    inventoryAvailabilityChecked: z.literal(false),
  }),
  categories: z.array(
    z.object({
      categoryIndex: count,
      name: text,
      url,
      observedOfferCount: count,
      pages: z.array(
        z.object({
          page: z.number().int().positive(),
          url,
          observedOfferCount: count,
        }),
      ),
    }),
  ),
  potentialDuplicates: z.array(
    z.object({
      normalizedName: text,
      sourceItemIds: z.array(text).min(2),
      sameObservedPriceAndBasis: z.boolean(),
      confirmedSameSku: z.literal(false),
      requiresManualReview: z.literal(true),
    }),
  ),
  offers: z.array(offerSchema),
  importRules: z.looseObject({
    automaticLiveImportAllowed: z.literal(false),
    doNotMergeSameNameOffersWithoutSkuCheck: z.literal(true),
  }),
});
const bylinkinoSchema = z.looseObject({
  schemaVersion: z.literal('1.0'),
  documentType: z.literal('MANUFACTURER_ASSORTMENT_WITHOUT_PRICES'),
  supplierName: z.literal('Былинкино'),
  sourceUrl: url,
  checkedOn: date,
  itemCount: count,
  completePhysicalStallAssortmentConfirmed: z.literal(false),
  notes: text,
  items: z.array(
    z.object({
      name: text,
      category: text,
      milkTypeIfExplicitlyStated: text.nullable(),
      retailStallPriceRubles: z.null(),
      saleUnit: z.null(),
      massGrams: z.null(),
      sku: z.null(),
      stockStatus: z.literal('UNKNOWN'),
      description: z.null(),
      allowAutomaticPublish: z.literal(false),
    }),
  ),
});

export function rublesToKopecks(value: number | string) {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(value));
  if (!match)
    throw new Error(
      `Цена должна иметь не более двух знаков после запятой: ${value}`,
    );
  const result =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (result <= 0n || result > 2_147_483_647n)
    throw new Error('Цена источника вне допустимого диапазона');
  return Number(result);
}

export function bylinkinoIdentity(
  row: z.infer<typeof bylinkinoSchema>['items'][number],
) {
  // This research identity includes the explicitly stated milk variant; it is not a SKU.
  return JSON.stringify([
    normalize(row.category),
    normalize(row.name),
    row.milkTypeIfExplicitlyStated && normalize(row.milkTypeIfExplicitlyStated),
  ]);
}

export function duplicateGroups(
  offers: readonly z.infer<typeof offerSchema>[],
) {
  const groups = new Map<string, z.infer<typeof offerSchema>[]>();
  for (const row of offers) {
    const name = normalize(row.name);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([normalizedName, rows]) => ({
      normalizedName,
      sourceItemIds: rows.map((row) => row.sourceItemId),
      sameObservedPriceAndBasis: rows.every(
        (row) =>
          row.sourcePriceKopecks === rows[0].sourcePriceKopecks &&
          row.sourcePriceBasis.massGrams === rows[0].sourcePriceBasis.massGrams,
      ),
      confirmedSameSku: false as const,
      requiresManualReview: true as const,
      offers: rows.map((row) => ({
        sourceItemId: row.sourceItemId,
        name: row.name,
        url: row.sourceProductUrl,
        priceKopecks: row.sourcePriceKopecks,
        priceQtyGrams: row.sourcePriceBasis.massGrams,
      })),
    }));
}

export function parseResearch(
  storesInput: unknown,
  myasberryInput: unknown,
  bylinkinoInput: unknown,
) {
  const stores = storesSchema.parse(storesInput);
  const myasberry = myasberrySchema.parse(myasberryInput);
  const bylinkino = bylinkinoSchema.parse(bylinkinoInput);
  const errors: string[] = [];
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length)
      errors.push(`Повторяющийся ${label}`);
  };
  unique(
    stores.sources.map((row) => row.id),
    'source id',
  );
  unique(
    stores.additionalNames.map((row) => row.researchKey),
    'researchKey',
  );
  unique(
    stores.siteSnapshot.points.map((row) => row.slug),
    'snapshot slug',
  );
  unique(
    myasberry.offers.map((row) => row.sourceItemId),
    'sourceItemId',
  );
  unique(
    myasberry.categories.map((row) => String(row.categoryIndex)),
    'categoryIndex',
  );
  unique(
    myasberry.potentialDuplicates.map((row) => row.normalizedName),
    'название группы дублей',
  );
  unique(bylinkino.items.map(bylinkinoIdentity), 'вариант Былинкино');
  const ids = new Set(stores.sources.map((row) => row.id));
  const candidates = [
    ...stores.additionalNames,
    ...stores.possibleAliasesExcludedFromNewShopCount,
    ...stores.historicalOrUnconfirmedListingsExcludedFromNewShopCount,
  ];
  for (const row of candidates)
    for (const id of row.sourceIds)
      if (!ids.has(id)) errors.push(`Не найден источник ${id}`);
  for (const row of stores.additionalNames)
    for (const contact of row.contacts)
      if (!ids.has(contact.sourceId))
        errors.push(`Не найден источник телефона ${contact.sourceId}`);
  for (const row of stores.existingPointChecks)
    if (!ids.has(row.sourceId))
      errors.push(`Не найден источник проверки ${row.sourceId}`);
  if (
    !stores.additionalNames.some((row) => row.researchKey === 'myasberry') ||
    !stores.additionalNames.some((row) => row.researchKey === 'bylinkino')
  )
    errors.push('Не найдены исследовательские записи поставщиков');
  if (
    stores.summary.existingSitePointCount !==
      stores.siteSnapshot.points.length ||
    stores.summary.additionalNamesForVerification !==
      stores.additionalNames.length ||
    stores.summary.onlineReferenceOfferCount !== myasberry.offers.length ||
    bylinkino.itemCount !== bylinkino.items.length ||
    myasberry.coverage.observedCatalogOfferCount !== myasberry.offers.length ||
    myasberry.coverage.distinctSourceItemIdCount !==
      new Set(myasberry.offers.map((row) => row.sourceItemId)).size
  )
    errors.push('Счётчики записей не соответствуют содержимому файлов');
  const groups = duplicateGroups(myasberry.offers);
  if (
    groups.length !== myasberry.coverage.potentialDuplicateNameGroups ||
    new Set(myasberry.offers.map((row) => normalize(row.name))).size !==
      myasberry.coverage.distinctNormalizedNames ||
    groups.length !== myasberry.potentialDuplicates.length
  )
    errors.push('Неверные счётчики возможных дублей');
  for (const group of myasberry.potentialDuplicates) {
    const actual = groups.find(
      (row) => row.normalizedName === group.normalizedName,
    );
    if (
      !actual ||
      [...actual.sourceItemIds].sort().join(',') !==
        [...group.sourceItemIds].sort().join(',') ||
      actual.sameObservedPriceAndBasis !== group.sameObservedPriceAndBasis
    )
      errors.push(`Неверная группа дублей: ${group.normalizedName}`);
  }
  if (
    myasberry.coverage.topLevelCategoriesObserved !==
      myasberry.categories.length ||
    myasberry.coverage.listingPagesObserved !==
      myasberry.categories.reduce((sum, row) => sum + row.pages.length, 0)
  )
    errors.push('Неверное количество разделов или страниц');
  for (const category of myasberry.categories) {
    const rows = myasberry.offers.filter(
      (row) => row.categoryIndex === category.categoryIndex,
    );
    if (
      rows.length !== category.observedOfferCount ||
      category.pages.reduce((sum, row) => sum + row.observedOfferCount, 0) !==
        rows.length
    )
      errors.push(`Неверное количество карточек: ${category.name}`);
  }
  for (const row of myasberry.offers) {
    try {
      const basis = row.sourcePriceBasis;
      const parsed = /^(\d+(?:[.,]\d{1,2})?)R\s+RUB\s+(\d+)\s+(г|гр|кг)$/.exec(
        row.sourcePriceText,
      );
      if (
        rublesToKopecks(row.sourcePriceRubles) !== row.sourcePriceKopecks ||
        !parsed ||
        rublesToKopecks(parsed[1]) !== row.sourcePriceKopecks ||
        Number(parsed[2]) !== basis.quantity ||
        parsed[3] !== basis.sourceUnitText
      )
        errors.push(
          `${row.sourceItemId}: цена или единица не соответствует исходному тексту`,
        );
      if (
        basis.massGrams !== basis.quantity * (basis.unit === 'kg' ? 1000 : 1) ||
        (basis.unit === 'kg') !== (basis.sourceUnitText === 'кг')
      )
        errors.push(`${row.sourceItemId}: неверная масса ценовой базы`);
      if (
        row.observedOn !== myasberry.checkedOn ||
        !myasberry.categories.some(
          (category) =>
            category.categoryIndex === row.categoryIndex &&
            category.name === row.categoryName,
        )
      )
        errors.push(`${row.sourceItemId}: неверная дата или категория`);
    } catch (error) {
      errors.push(
        `${row.sourceItemId}: ${error instanceof Error ? error.message : 'Некорректная цена'}`,
      );
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { stores, myasberry, bylinkino, duplicateGroups: groups };
}

export async function readResearch(directory: URL = inputDirectory) {
  const inputs = await Promise.all(
    Object.values(inputFiles).map(async (name) => {
      const input: unknown = JSON.parse(
        await readFile(new URL(name, directory), 'utf8'),
      );
      return input;
    }),
  );
  return parseResearch(inputs[0], inputs[1], inputs[2]);
}

export type Research = ReturnType<typeof parseResearch>;
