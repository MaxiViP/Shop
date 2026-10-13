import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { readPlan, applyPlan } from './apply.js';
const args = process.argv.slice(2);
const planIndex = args.indexOf('--plan');
let planFile: string | undefined;
if (planIndex !== -1) {
  planFile = args[planIndex + 1];
  if (!planFile || planFile.startsWith('--')) throw new Error('--plan requires a reviewed local plan path');
  args.splice(planIndex, 2);
}
if (
  args.some((arg) => !['--dry-run', '--apply-local'].includes(arg)) ||
  (args.includes('--dry-run') && args.includes('--apply-local'))
)
  throw new Error('Use --dry-run (default) or --apply-local');
const url = process.env.DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
)
  throw new Error(
    'Only a local database is permitted. Production is excluded.',
  );
const apply = args.includes('--apply-local');
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
try {
  const result = await applyPlan(db, await readPlan(planFile), apply);
  const file = planFile ? `${planFile}.${apply ? 'apply' : 'dry-run'}.json` : new URL(
    `../../../../docs/catalog-sale-audit/${apply ? 'apply' : 'dry-run'}.json`,
    import.meta.url,
  );
  await writeFile(
    file,
    JSON.stringify(
      { checkedAt: new Date().toISOString(), ...result },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.$disconnect();
}
