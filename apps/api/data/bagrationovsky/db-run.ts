import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../../src/db/gen/client.js';
import { inputDirectory } from './input.js';
import { queueSchema } from './queue.js';

// Unlike the research queue CLI, this imports only isolated ADMIN draft records.
// It NEVER writes MarketPoint, Product, ProductImage, Category, or Order.
const args = process.argv.slice(2);
if (
  args.some((arg) => !['--apply', '--dry-run'].includes(arg)) ||
  new Set(args).size !== args.length ||
  (args.includes('--apply') && args.includes('--dry-run'))
) throw new Error('Usage: pnpm --filter api bagrationovsky:drafts [--dry-run|--apply]');
const apply = args.includes('--apply');
const queueUrl = new URL('prepared/import-queue.json', inputDirectory);
const queue = queueSchema.parse(JSON.parse(await readFile(fileURLToPath(queueUrl), 'utf8')));
if (queue.customerVisible || queue.orderable || queue.readyForDatabaseImport ||
    queue.stores.length !== 16 || queue.products.length !== 168)
  throw new Error('Unexpected research queue: import blocked');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dbUrl = new URL(url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) ||
    !['postgresql:', 'postgres:'].includes(dbUrl.protocol))
  throw new Error('Only loopback PostgreSQL is allowed');
const schema = dbUrl.searchParams.get('schema') ?? 'public';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid schema');
const db = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: url, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema}` },
    { schema },
  ),
});
try {
  await db.$connect();
  const storeKeys = queue.stores.map((row) => row.key);
  const productKeys = queue.products.map((row) => row.key);
  const [existingStores, existingProducts] = await db.$transaction([
    db.researchStoreDraft.findMany({ where: { key: { in: storeKeys } }, select: { key: true, datasetId: true, source: true } }),
    db.researchProductDraft.findMany({ where: { key: { in: productKeys } }, select: { key: true, datasetId: true, source: true } }),
  ]);
  // PostgreSQL JSONB normalizes object key order. Compare canonical JSON, not textual order.
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
  const storeByKey = new Map(existingStores.map((row) => [row.key, row]));
  const productByKey = new Map(existingProducts.map((row) => [row.key, row]));
  const changed = [
    ...queue.stores.filter((row) => {
      const old = storeByKey.get(row.key);
      return old && (old.datasetId !== queue.datasetId || canonical(old.source) !== canonical(row.source));
    }).map((row) => row.key),
    ...queue.products.filter((row) => {
      const old = productByKey.get(row.key);
      return old && (old.datasetId !== queue.datasetId || canonical(old.source) !== canonical(row.source));
    }).map((row) => row.key),
  ];
  const summary = {
    ok: changed.length === 0,
    dryRun: !apply,
    datasetId: queue.datasetId,
    stores: { total: queue.stores.length, alreadyPresent: existingStores.length, new: queue.stores.length - existingStores.length },
    products: { total: queue.products.length, alreadyPresent: existingProducts.length, new: queue.products.length - existingProducts.length },
    sourceConflicts: changed,
    publicRecordsChanged: 0,
  };
  if (changed.length) throw new Error(`Research keys have changed source data: ${changed.join(', ')}`);
  if (apply) {
    const created = await db.$transaction(async (tx) => {
      const stores = await tx.researchStoreDraft.createMany({
        data: queue.stores.map((row) => ({
          key: row.key,
          datasetId: queue.datasetId,
          source: row.source as Prisma.InputJsonValue,
          review: row.review as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      const products = await tx.researchProductDraft.createMany({
        data: queue.products.map((row) => ({
          key: row.key,
          datasetId: queue.datasetId,
          source: row.source as Prisma.InputJsonValue,
          review: row.review as Prisma.InputJsonValue,
          sale: row.sale as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      return { stores: stores.count, products: products.count };
    }, { isolationLevel: 'Serializable' });
    console.log(JSON.stringify({ ...summary, dryRun: false, created }, null, 2));
  } else console.log(JSON.stringify(summary, null, 2));
} finally {
  await db.$disconnect();
}
