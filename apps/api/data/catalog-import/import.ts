import type { Prisma, PrismaClient } from '../../src/db/gen/client.js';
import { productSchema } from '../../src/admin/schema.js';
import { priceBreakdown } from '../../src/product/pricing.js';
import {
  packWeight,
  parseCatalog,
  productValues,
  type Catalog,
  type CatalogRow,
} from './input.js';

const normalize = (name: string) =>
  name
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/(?:^|\s)свеж(?:ий|ая|ее|ие)(?=$|[\s,.])/gu, ' ')
    .replace(/(?:^|[\s,])1\s*(?:шт\.?|пучок|кочан)(?=$|[\s,.])/gu, ' ')
    .replace(/[«»"'.,]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
// These unqualified names describe the same variety; do not alias generic potatoes or avocados.
const nameAliases: Readonly<Record<string, readonly string[]>> = {
  'tomatoes-pink': ['Томаты розовые'],
  lemons: ['Лимон'],
};
const select = {
  id: true,
  slug: true,
  name: true,
  description: true,
  price: true,
  priceStatus: true,
  unit: true,
  priceQty: true,
  active: true,
  categoryId: true,
  marketPointId: true,
  sourceUrl: true,
  sourceCheckedAt: true,
} satisfies Prisma.ProductSelect;
type CurrentProduct = Prisma.ProductGetPayload<{ select: typeof select }>;
type Match = 'slug' | 'previousSlug' | 'name-unit-pack';

function sameSale(current: CurrentProduct, row: CatalogRow) {
  return (
    current.unit === row.unit &&
    current.priceQty === row.priceQty &&
    (row.unit !== 'PACK' || packWeight(current.name) === row.netWeightGrams)
  );
}

function details(
  current: CurrentProduct,
  row: CatalogRow,
  pointId: number,
): Prisma.ProductUncheckedUpdateInput {
  return {
    ...(!current.description?.trim() ? { description: row.description } : {}),
    ...(current.marketPointId === null ? { marketPointId: pointId } : {}),
    ...(!current.sourceUrl
      ? {
          sourceUrl: row.sourceUrl,
          sourceCheckedAt: new Date(row.sourceCheckedAt),
        }
      : {}),
  };
}

export function fileSummary(catalog: Catalog) {
  const counts = (values: readonly string[]) => {
    const result: Record<string, number> = {};
    for (const value of values) result[value] = (result[value] ?? 0) + 1;
    return result;
  };
  return {
    total: catalog.products.length,
    categories: counts(catalog.products.map((row) => row.categorySlug)),
    units: counts(catalog.products.map((row) => row.unit)),
    packs: catalog.products
      .filter((row) => row.unit === 'PACK')
      .map((row) => ({
        slug: row.slug,
        netWeightGrams: row.netWeightGrams,
        priceQty: row.priceQty,
        sellerPrice: row.sellerPrice,
      })),
  };
}

// All matching and writes share a serializable snapshot. A failed plan writes nothing.
export async function importCatalog(
  db: PrismaClient,
  input: Catalog,
  dryRun = true,
) {
  const catalog = parseCatalog(input);
  return db.$transaction(
    async (tx) => {
      if (dryRun) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const errors: string[] = [];
      const point = await tx.marketPoint.findUnique({
        where: { slug: catalog.marketPointSlug },
        select: { id: true, slug: true, name: true },
      });
      if (!point)
        errors.push(
          `Не найдена торговая точка ${catalog.marketPointSlug}; импорт не создаёт торговые точки.`,
        );
      const currentCategories = await tx.category.findMany({
        select: { id: true, slug: true, name: true },
      });
      const categories = catalog.categories.map((row) => {
        const candidates = currentCategories.filter(
          (category) =>
            category.slug === row.slug ||
            normalize(category.name) === normalize(row.name),
        );
        const current = candidates.length === 1 ? candidates[0] : undefined;
        const canCreate =
          candidates.length === 0 &&
          row.slug === 'berries' &&
          row.name === 'Ягоды';
        if (!current && !canCreate)
          errors.push(
            `Категория ${row.slug}: ${candidates.length > 1 ? 'неоднозначное совпадение' : 'не найдена'}`,
          );
        return {
          ...row,
          id: current?.id ?? null,
          existingSlug: current?.slug ?? null,
          action: current
            ? ('keep' as const)
            : canCreate
              ? ('create' as const)
              : ('skip' as const),
        };
      });
      const currentProducts = await tx.product.findMany({ select });
      const claimed = new Map<number, string>();
      const products = catalog.products.map((row) => {
        const category = categories.find(
          (category) => category.slug === row.categorySlug,
        );
        const slugs = currentProducts.filter(
          (current) =>
            current.slug === row.slug || current.slug === row.previousSlug,
        );
        const names = [row.name, ...(nameAliases[row.catalogKey] ?? [])].map(
          normalize,
        );
        const byName = currentProducts.filter(
          (current) =>
            point &&
            (current.marketPointId === point.id ||
              current.marketPointId === null) &&
            current.categoryId === category?.id &&
            sameSale(current, row) &&
            names.includes(normalize(current.name)),
        );
        const candidates = [
          ...new Map(
            [...slugs, ...byName].map((current) => [current.id, current]),
          ).values(),
        ];
        const current = candidates.length === 1 ? candidates[0] : undefined;
        let issue: string | null = null;
        if (!point || !category || category.action === 'skip')
          issue = 'Не разрешены торговая точка или категория';
        else if (candidates.length > 1)
          issue = 'Несколько существующих товаров соответствуют позиции';
        else if (
          current &&
          ((current.marketPointId !== null &&
            current.marketPointId !== point.id) ||
            current.categoryId !== category.id ||
            !sameSale(current, row))
        )
          issue =
            'Slug занят товаром с другой торговой точкой, категорией, единицей или фасовкой';
        else if (current && claimed.has(current.id))
          issue = `Товар уже сопоставлен с ${claimed.get(current.id)}`;
        if (current) claimed.set(current.id, row.slug);
        if (issue) errors.push(`${row.slug}: ${issue}`);
        const update =
          current && point && !issue ? details(current, row, point.id) : {};
        const updates = Object.keys(update);
        const matchedBy: Match | null = !current
          ? null
          : current.slug === row.slug
            ? 'slug'
            : current.slug === row.previousSlug
              ? 'previousSlug'
              : 'name-unit-pack';
        const finalSlug = current?.slug ?? row.slug;
        return {
          catalogKey: row.catalogKey,
          proposedSlug: row.slug,
          previousSlug: row.previousSlug,
          slug: finalSlug,
          name: current?.name ?? row.name,
          id: current?.id ?? null,
          categorySlug: row.categorySlug,
          unit: row.unit,
          priceQty: row.priceQty,
          netWeightGrams: row.netWeightGrams,
          inputSellerPrice: row.sellerPrice,
          ...priceBreakdown(current?.price ?? row.sellerPrice),
          priceStatus: current?.priceStatus ?? row.priceStatus,
          active: current?.active ?? false,
          action: issue
            ? ('skip' as const)
            : !current
              ? ('create' as const)
              : updates.length
                ? ('update' as const)
                : ('unchanged' as const),
          matchedBy,
          updates,
          issue,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            slug: candidate.slug,
          })),
          photoFileName: `${finalSlug}.webp`,
        };
      });
      // Preflight finishes for every row before the first mutation.
      if (!dryRun && errors.length) throw new Error(errors.join('\n'));
      if (!dryRun) {
        for (const category of categories)
          if (category.action === 'create') {
            const created = await tx.category.create({
              data: { name: 'Ягоды', slug: 'berries', sort: category.sort },
            });
            category.id = created.id;
          }
        for (const [index, plan] of products.entries()) {
          const row = catalog.products[index];
          if (plan.action === 'create') {
            const categoryId = categories.find(
              (category) => category.slug === row.categorySlug,
            )?.id;
            if (!categoryId || !point)
              throw new Error('Не разрешены связи товара');
            const data = productSchema.parse(
              productValues(row, categoryId, point.id),
            );
            const created = await tx.product.create({ data });
            plan.id = created.id;
          } else if (plan.action === 'update') {
            const current = currentProducts.find(
              (current) => current.id === plan.id,
            );
            if (!current || !point)
              throw new Error('Не найден сопоставленный товар');
            // No price, priceStatus, active, images, slug, name or sale quantities enter this patch.
            await tx.product.update({
              where: { id: current.id },
              data: details(current, row, point.id),
            });
          }
        }
      }
      return {
        ok: errors.length === 0,
        dryRun,
        databaseMatched: true,
        datasetId: catalog.datasetId,
        revision: catalog.revision,
        fileValidation: fileSummary(catalog),
        marketPoint: point,
        categories,
        errors,
        summary: {
          total: products.length,
          created: products.filter((row) => row.action === 'create').length,
          matched: products.filter(
            (row) => row.matchedBy !== null && row.action !== 'skip',
          ).length,
          updated: products.filter((row) => row.action === 'update').length,
          unchanged: products.filter((row) => row.action === 'unchanged')
            .length,
          skipped: products.filter((row) => row.action === 'skip').length,
        },
        products,
      };
    },
    { isolationLevel: 'Serializable', timeout: 60_000 },
  );
}
