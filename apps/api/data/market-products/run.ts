import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { importMarketProducts } from './import.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--dry-run', '--apply'].includes(args[0]!)))
  throw new Error('Использование: tsx data/market-products/run.ts [--dry-run|--apply]');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  const result = await importMarketProducts(db, args[0] !== '--apply');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ошибка импорта');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
