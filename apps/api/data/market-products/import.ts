import type { Prisma, PrismaClient } from '../../src/db/gen/client.js';
import { productSchema } from '../../src/admin/schema.js';
import { priceBreakdown } from '../../src/product/pricing.js';
import { categories, expectedCounts, marketProducts } from './2026-10-06.js';

export function validateMarketProducts(products: typeof marketProducts) {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of products) {
    if (slugs.has(row.slug)) throw new Error(`Повторяющийся Product slug: ${row.slug}`);
    slugs.add(row.slug);
    if (!row.slug.startsWith(`${row.marketPointSlug}-`)) throw new Error(`Slug без MarketPoint: ${row.slug}`);
    if (!categories.some(category => category.slug === row.categorySlug)) throw new Error(`Неизвестная категория: ${row.categorySlug}`);
    productSchema.parse({ name: row.name, slug: row.slug, description: null,
      price: row.sellerPrice, priceQty: row.priceQty, unit: row.unit, min: row.min,
      step: row.step, portionQty: row.portionQty, categoryId: 1, active: true, sort: 0,
      sourceUrl: row.sourceUrl, sourceCheckedAt: row.sourceCheckedAt });
    priceBreakdown(row.sellerPrice);
    counts.set(row.marketPointSlug, (counts.get(row.marketPointSlug) ?? 0) + 1);
  }
  for (const [slug, count] of Object.entries(expectedCounts))
    if (counts.get(slug) !== count) throw new Error(`Dataset ${slug}: ожидалось ${count}, получено ${counts.get(slug) ?? 0}`);
  if (products.length !== Object.values(expectedCounts).reduce((sum, count) => sum + count, 0))
    throw new Error('Неверное количество товаров в dataset');
  return Object.fromEntries(counts);
}

const productSelect = { id: true, slug: true, name: true, price: true, priceQty: true,
  unit: true, min: true, step: true, portionQty: true, categoryId: true, marketPointId: true,
  sourceUrl: true, sourceCheckedAt: true } satisfies Prisma.ProductSelect;

// Every check and every write uses one serializable transaction. Dry-run is read-only.
export async function importMarketProducts(db: PrismaClient, dryRun = true) {
  const counts = validateMarketProducts(marketProducts);
  return db.$transaction(async tx => {
    if (dryRun) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const points = await tx.marketPoint.findMany({
      where: { slug: { in: Object.keys(expectedCounts) } }, select: { id: true, slug: true },
    });
    const missing = Object.keys(expectedCounts).filter(slug => !points.some(point => point.slug === slug));
    if (missing.length) {
      const error = `Не найдены MarketPoint: ${missing.join(', ')}. Импорт не создаёт торговые точки.`;
      if (!dryRun) throw new Error(error);
      return { ok: false as const, dryRun, counts, errors: [error], products: [] };
    }
    const currentCategories = await tx.category.findMany({ where: { slug: { in: categories.map(row => row.slug) } } });
    const currentProducts = await tx.product.findMany({ where: { slug: { in: marketProducts.map(row => row.slug) } }, select: productSelect });
    const pointIds = new Map(points.map(row => [row.slug, row.id]));
    const categoryIds = new Map(currentCategories.map(row => [row.slug, row.id]));
    const existing = new Map(currentProducts.map(row => [row.slug, row]));
    const collisions = marketProducts.filter(row => {
      const current = existing.get(row.slug);
      return current && (current.marketPointId !== pointIds.get(row.marketPointSlug) || !current.sourceUrl);
    });
    if (collisions.length) {
      const error = `Slug занят посторонним товаром: ${collisions.map(row => row.slug).join(', ')}`;
      if (!dryRun) throw new Error(error);
      return { ok: false as const, dryRun, counts, errors: [error], products: [] };
    }
    const plan = marketProducts.map(row => {
      const current = existing.get(row.slug);
      const values = { name: row.name, price: row.sellerPrice, priceQty: row.priceQty,
        unit: row.unit, min: row.min, step: row.step, portionQty: row.portionQty,
        marketPointId: pointIds.get(row.marketPointSlug)!, sourceUrl: row.sourceUrl };
      const unchanged = current && Object.entries(values).every(([key, value]) => current[key as keyof typeof current] === value)
        && current.categoryId === categoryIds.get(row.categorySlug)
        && current.sourceCheckedAt?.toISOString() === row.sourceCheckedAt;
      return { slug: row.slug, marketPoint: row.marketPointSlug, category: row.categorySlug,
        action: !current ? 'create' as const : unchanged ? 'unchanged' as const : 'update' as const,
        ...priceBreakdown(row.sellerPrice), values, checkedAt: new Date(row.sourceCheckedAt) };
    });
    if (!dryRun) {
      for (const row of categories) {
        const category = await tx.category.upsert({ where: { slug: row.slug }, create: row, update: {} });
        categoryIds.set(row.slug, category.id);
      }
      for (const [index, row] of plan.entries()) {
        if (row.action === 'unchanged') continue;
        const values = { ...row.values, categoryId: categoryIds.get(row.category)!, sourceCheckedAt: row.checkedAt };
        await tx.product.upsert({ where: { slug: row.slug }, update: values,
          create: { ...values, slug: row.slug, sort: index + 1 } });
      }
    }
    return { ok: true as const, dryRun, counts, errors: [],
      categories: categories.map(row => ({ slug: row.slug, action: currentCategories.some(current => current.slug === row.slug) ? 'keep' : 'create' })),
      created: plan.filter(row => row.action === 'create').length,
      updated: plan.filter(row => row.action === 'update').length,
      unchanged: plan.filter(row => row.action === 'unchanged').length,
      products: plan.map(({ values: _values, checkedAt: _checkedAt, ...row }) => row) };
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}
