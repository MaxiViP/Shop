import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { fileSummary, importCatalog } from './import.js';
import { catalogFile, readCatalog } from './input.js';

const args = process.argv.slice(2);
if (
  new Set(args).size !== args.length ||
  args.some(
    (arg) =>
      !['--dry-run', '--apply'].includes(arg) && !arg.startsWith('--report='),
  ) ||
  args.filter((arg) => arg.startsWith('--report=')).length > 1 ||
  (args.includes('--dry-run') && args.includes('--apply'))
)
  throw new Error(
    'Использование: pnpm --filter api catalog:import [--dry-run|--apply] [--report=path.json]',
  );
const dryRun = !args.includes('--apply');
const directory = dirname(fileURLToPath(catalogFile));
const reportFile = resolve(
  args.find((arg) => arg.startsWith('--report='))?.slice('--report='.length) ??
    resolve(directory, 'reports', dryRun ? 'dry-run.json' : 'apply.json'),
);
const save = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const failureCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'CONNECTION_ERROR';

let db: PrismaClient | undefined;
try {
  // File validation completes even if DATABASE_URL is absent or PostgreSQL is unavailable.
  const catalog = await readCatalog();
  let preflight: Awaited<ReturnType<typeof importCatalog>> | undefined;
  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const target = new URL(connectionString);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error(
        'Разрешена только локальная/тестовая PostgreSQL на loopback-адресе.',
      );
    const schema = target.searchParams.get('schema') ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
      throw new Error('Недопустимое имя схемы БД');
    db = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString,
          connectionTimeoutMillis: 5000,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    await db.$connect();
    preflight = await importCatalog(db, catalog);
  } catch (error) {
    const reason = db
      ? failureCode(error)
      : error instanceof Error
        ? error.message
        : 'CONFIGURATION_ERROR';
    const result = {
      ok: false,
      dryRun,
      databaseMatched: false,
      fileValidation: fileSummary(catalog),
      errors: [
        `БД не подключена (${reason}); сопоставление с БД не выполнено.`,
      ],
    };
    await save(reportFile, result);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
  if (db && preflight) {
    // --apply always performs a fresh read-only dry-run before the write transaction.
    let result = preflight;
    if (!dryRun && preflight.ok) {
      await save(resolve(dirname(reportFile), 'pre-apply.json'), preflight);
      result = await importCatalog(db, catalog, false);
    }
    await save(reportFile, result);
    if (!dryRun && result.ok)
      await save(resolve(directory, 'photo-map.json'), {
        datasetId: catalog.datasetId,
        revision: catalog.revision,
        status: 'NOT_GENERATED',
        products: result.products.map((row) => ({
          catalogKey: row.catalogKey,
          proposedSlug: row.proposedSlug,
          slug: row.slug,
          productId: row.id,
          fileName: row.photoFileName,
          netWeightGrams: row.netWeightGrams,
        })),
      });
    console.log(
      JSON.stringify(
        {
          ...result,
          products: result.products.filter(
            (row) =>
              row.action === 'skip' ||
              (row.matchedBy !== null &&
                (row.matchedBy !== 'slug' || row.action === 'update')),
          ),
          reportFile,
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ошибка импорта');
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
