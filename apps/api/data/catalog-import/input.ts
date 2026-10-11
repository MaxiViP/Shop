import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { productSchema } from '../../src/admin/schema.js';

export const catalogFile = new URL(
  '../catalog-drafts/moscow-market-2026-10-11/shop-import.json',
  import.meta.url,
);
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(180);
const qty = z.number().int().positive().max(1_000_000);
const rowSchema = z.object({
  slug,
  name: z.string().min(1),
  description: z.string().min(1),
  sellerPrice: z.number().int().positive().max(100_000_000),
  priceStatus: z.literal('ESTIMATED'),
  unit: z.enum(['GRAM', 'PIECE', 'BUNCH', 'PACK']),
  priceQty: qty,
  step: qty,
  min: qty,
  portionQty: qty,
  categorySlug: slug,
  marketPointSlug: z.literal('vegetables-fruits-east'),
  active: z.literal(false),
  sort: z.number().int(),
  isSeasonal: z.literal(false),
  sourceUrl: z.url({ protocol: /^https?$/ }).max(2000),
  sourceCheckedAt: z.iso.datetime(),
  catalogKey: slug.optional(),
  previousSlug: slug.optional(),
  netWeightGrams: qty.nullable().optional(),
});
const inputSchema = z.object({
  schemaVersion: z.literal('1.1'),
  datasetId: z.literal('moscow-market-assortment-2026-10-11'),
  revision: z.literal(2),
  marketPointSlug: z.literal('vegetables-fruits-east'),
  productCount: z.number().int().positive(),
  categories: z
    .array(z.object({ slug, name: z.string().min(1), sort: z.number().int() }))
    .min(1),
  products: z.array(rowSchema).min(1),
});

export function packWeight(name: string): number | null {
  const matches = [...name.matchAll(/(\d+)\s*(кг|г)(?=$|[\s,.])/giu)];
  if (matches.length !== 1) return null;
  return (
    Number(matches[0][1]) * (matches[0][2].toLowerCase() === 'кг' ? 1000 : 1)
  );
}

export function productValues(
  row: z.infer<typeof rowSchema>,
  categoryId: number,
  marketPointId: number,
) {
  // Only real product fields enter the strict admin schema. Price previews and pack metadata never do.
  return {
    name: row.name,
    slug: row.slug,
    description: row.description,
    price: row.sellerPrice,
    priceStatus: row.priceStatus,
    unit: row.unit,
    priceQty: row.priceQty,
    step: row.step,
    min: row.min,
    portionQty: row.portionQty,
    active: row.active,
    sort: row.sort,
    isSeasonal: row.isSeasonal,
    categoryId,
    marketPointId,
    sourceUrl: row.sourceUrl,
    sourceCheckedAt: row.sourceCheckedAt,
  };
}

export function parseCatalog(input: unknown) {
  const catalog = inputSchema.parse(input);
  const errors: string[] = [];
  const unique = (values: readonly string[], label: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) errors.push(`Повторяющийся ${label}: ${value}`);
      seen.add(value);
    }
  };
  unique(
    catalog.categories.map((row) => row.slug),
    'categorySlug',
  );
  unique(
    catalog.products.map((row) => row.slug),
    'slug',
  );
  if (catalog.productCount !== catalog.products.length)
    errors.push(
      `Ожидалось ${catalog.productCount} товаров, получено ${catalog.products.length}`,
    );
  const products = catalog.products.map((row) => {
    const prefix = `${catalog.marketPointSlug}-`;
    if (!row.slug.startsWith(prefix))
      errors.push(`${row.slug}: slug без торговой точки`);
    const catalogKey = row.catalogKey ?? row.slug.slice(prefix.length);
    // Revision 1 used this prefix; the compact input omits these research metadata fields.
    const previousSlug = row.previousSlug ?? `moscow-market-${catalogKey}`;
    const weight = row.unit === 'PACK' ? packWeight(row.name) : null;
    const netWeightGrams = row.netWeightGrams ?? weight;
    if (row.unit === 'PACK' && (!weight || weight !== netWeightGrams))
      errors.push(
        `${row.slug}: фасовка PACK должна однозначно соответствовать массе в названии`,
      );
    if (
      row.unit === 'PACK' &&
      [row.priceQty, row.step, row.min, row.portionQty].some(
        (value) => value !== 1,
      )
    )
      errors.push(`${row.slug}: PACK продаётся упаковками, а не граммами`);
    if (
      !catalog.categories.some((category) => category.slug === row.categorySlug)
    )
      errors.push(`${row.slug}: неизвестная категория ${row.categorySlug}`);
    // Placeholder relation IDs are used only for file validation, never for DB resolution or writes.
    const check = productSchema.safeParse(productValues(row, 1, 1));
    if (!check.success)
      for (const issue of check.error.issues)
        errors.push(`${row.slug}: ${issue.path.join('.')}: ${issue.message}`);
    return { ...row, catalogKey, previousSlug, netWeightGrams };
  });
  unique(
    products.map((row) => row.catalogKey),
    'catalogKey',
  );
  unique(
    products.map((row) => row.previousSlug),
    'previousSlug',
  );
  if (errors.length) throw new Error(errors.join('\n'));
  return { ...catalog, products };
}

export async function readCatalog(file: URL = catalogFile) {
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  return parseCatalog(input);
}

export type Catalog = ReturnType<typeof parseCatalog>;
export type CatalogRow = Catalog['products'][number];
