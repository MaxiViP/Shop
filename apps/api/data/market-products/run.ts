import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { importMarketProducts } from './import.js';
import { estimatedDataset } from './2026-10-07-estimated.js';

const args = process.argv.slice(2);
const estimated = args.includes('--dataset=2026-10-07-estimated');
if (new Set(args).size !== args.length || args.some(arg => !['--dry-run', '--apply', '--dataset=2026-10-07-estimated'].includes(arg))
  || (args.includes('--dry-run') && args.includes('--apply')))
  throw new Error('Использование: tsx data/market-products/run.ts [--dataset=2026-10-07-estimated] [--dry-run|--apply]');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  const result = await importMarketProducts(db, !args.includes('--apply'), estimated ? estimatedDataset : undefined);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ошибка импорта');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
