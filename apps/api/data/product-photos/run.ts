import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { readPhotoPack } from '../../src/product/photo-pack.js';
import { importProductPhotos, validateProductPhotos } from '../../src/product/photo-import.js';

const args = process.argv.slice(2);
const modes = args.filter(arg => ['--audit', '--dry-run', '--apply', '--validate'].includes(arg));
if (new Set(args).size !== args.length || modes.length > 1 ||
  args.some(arg => !['--audit', '--dry-run', '--apply', '--validate', '--allow-remote'].includes(arg)))
  throw new Error('Использование: tsx data/product-photos/run.ts [--audit|--dry-run|--apply|--validate] [--allow-remote]');
let db: PrismaClient | undefined;
try {
  const pack = await readPhotoPack(fileURLToPath(new URL('./2026-10-07/', import.meta.url)));
  if (modes[0] === '--audit') {
    console.log(JSON.stringify(pack.audit, null, 2));
    if (!pack.audit.clean) process.exitCode = 1;
  } else {
    if (!pack.audit.clean) throw new Error(`Фотопак не прошёл аудит: ${JSON.stringify(pack.audit)}`);
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname) && !args.includes('--allow-remote'))
      throw new Error('По умолчанию разрешена только локальная БД. Для согласованного remote import нужен --allow-remote.');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    const result = modes[0] === '--validate' ? await validateProductPhotos(db, pack)
      : await importProductPhotos(db, pack, modes[0] !== '--apply');
    console.log(JSON.stringify(result, null, 2));
    if ('wrongAssignments' in result && result.wrongAssignments) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ошибка импорта фотографий');
  process.exitCode = 1;
} finally { await db?.$disconnect(); }
