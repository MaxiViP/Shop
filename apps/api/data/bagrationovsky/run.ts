import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { inputDirectory, inputFiles, readResearch } from './input.js';
import {
  planImport,
  readQueue,
  readSnapshot,
  saveQueue,
  type Snapshot,
} from './queue.js';

const args = process.argv.slice(2);
if (
  new Set(args).size !== args.length ||
  args.some(
    (arg) =>
      !['--dry-run', '--prepare', '--offline'].includes(arg) &&
      !arg.startsWith('--report=') &&
      !arg.startsWith('--queue='),
  ) ||
  (args.includes('--dry-run') && args.includes('--prepare')) ||
  ['--report=', '--queue='].some(
    (prefix) => args.filter((arg) => arg.startsWith(prefix)).length > 1,
  )
)
  throw new Error(
    'Использование: pnpm --filter api bagrationovsky:import [--dry-run|--prepare] [--offline] [--queue=path.json] [--report=path.json]. Запись в БД не поддерживается.',
  );
const prepare = args.includes('--prepare');
const root = fileURLToPath(inputDirectory);
const queueFile = resolve(
  args.find((arg) => arg.startsWith('--queue='))?.slice('--queue='.length) ??
    resolve(root, 'prepared/import-queue.json'),
);
const reportFile = resolve(
  args.find((arg) => arg.startsWith('--report='))?.slice('--report='.length) ??
    resolve(root, 'reports', prepare ? 'prepare.json' : 'preview.json'),
);
const pathKey = (file: string) =>
  process.platform === 'win32' ? file.toLowerCase() : file;
if (pathKey(queueFile) === pathKey(reportFile))
  throw new Error('Файлы очереди и отчёта должны различаться');
const sourceFiles = [
  ...Object.values(inputFiles),
  'bagrationovsky-research-notes-2026-10-11.md',
  'README.md',
].map((name) => pathKey(resolve(root, name)));
if ([queueFile, reportFile].some((file) => sourceFiles.includes(pathKey(file))))
  throw new Error(
    'Выходной файл не должен перезаписывать исходные данные или пояснения',
  );
let db: PrismaClient | undefined;
try {
  const research = await readResearch();
  const previousText = await readQueue(queueFile);
  const previous: unknown =
    previousText === undefined ? undefined : JSON.parse(previousText);
  let snapshot: Snapshot | null = null;
  const warnings: string[] = [];
  if (!args.includes('--offline')) {
    try {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL отсутствует');
      const target = new URL(connectionString);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
        throw new Error(
          'Сопоставление разрешено только с локальной БД; доступен --offline',
        );
      const schema = target.searchParams.get('schema') ?? 'public';
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
        throw new Error('Некорректное имя схемы');
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
      snapshot = await readSnapshot(db);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : db
            ? 'CONNECTION_ERROR'
            : error instanceof Error
              ? error.message
              : 'CONFIGURATION_ERROR';
      warnings.push(
        `Сопоставление с БД не выполнено (${code}); все связи требуют проверки.`,
      );
    }
  } else warnings.push('Режим --offline: сопоставление с БД не выполнено.');
  const result = planImport(research, snapshot, previous);
  const queueWritten = prepare
    ? await saveQueue(queueFile, result.queue, previousText)
    : false;
  const report = {
    ...result.preview,
    mode: prepare ? 'prepare_file_queue' : 'dry_run',
    queueFile,
    queueWritten,
    warnings,
  };
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        mode: report.mode,
        databaseMatched: report.databaseMatched,
        liveDatabaseWrites: report.liveDatabaseWrites,
        summary: report.summary,
        warnings,
        stores: report.stores.map((row) => ({
          name: row.name,
          action: row.action,
          requiresReview: row.requiresReview,
          candidates: row.candidates.map((point) => ({
            id: point.id,
            slug: point.slug,
            name: point.name,
            evidence: point.evidence,
            confirmed: false,
          })),
        })),
        snapshotPointsRequiringReview: report.knownPoints
          .filter((row) => row.action !== 'skip_existing')
          .map((row) => ({ slug: row.slug, action: row.action })),
        productsPreview: [
          report.products[0],
          report.products[1],
          report.products.find((row) => row.supplierKey === 'bylinkino'),
        ],
        duplicateGroups: report.duplicateGroups.map((row) => ({
          normalizedName: row.normalizedName,
          sourceItemIds: row.sourceItemIds,
          sameObservedPriceAndBasis: row.sameObservedPriceAndBasis,
          confirmedSameSku: row.confirmedSameSku,
        })),
        excluded: report.excluded.map((row) => ({
          name: row.name,
          action: row.action,
          reason: row.reason,
        })),
        queueFile,
        queueWritten,
        reportFile,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Ошибка подготовки очереди',
  );
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
