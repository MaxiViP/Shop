import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';
import { readPlan } from './apply.js';

// Rebase only confirmed corrections onto a fresh local snapshot; never write products.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1])
  throw new Error('Use catalog:sale-plan --output /tmp/reviewed-sale-plan.json');
const url = process.env.DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Only an explicitly configured local database is permitted');
const baseline = await readPlan();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const plan = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const patches: typeof baseline.patches = [];
    for (const patch of baseline.patches) {
      const current = await tx.product.findUnique({ where: { slug: patch.slug } });
      if (!current || current.name !== patch.name || current.sourceUrl !== (patch.sourceUrl ?? null))
        throw new Error(`Identity/source needs review: ${patch.slug}`);
      const keys = Object.keys(patch.after) as (keyof typeof patch.after)[];
      if (keys.every(key => current[key] === patch.after[key])) continue;
      if (!keys.every(key => current[key] === patch.before[key]))
        throw new Error(`Sale configuration needs review: ${patch.slug}`);
      patches.push({ ...patch, productId: current.id, expectedUpdatedAt: current.updatedAt.toISOString() });
    }
    return { ...baseline, databaseCheckedAt: new Date().toISOString(), patches };
  }, { isolationLevel: 'RepeatableRead' });
  // Never overwrite a reviewed plan or the dated audit report.
  await writeFile(args[1], JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  console.log(`Prepared ${plan.patches.length} confirmed local corrections for review; database unchanged.`);
} finally { await db.$disconnect(); }
