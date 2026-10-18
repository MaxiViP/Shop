import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/db/gen/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname))
  throw new Error('Only a configured local database may be audited');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  const products = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return tx.product.findMany({ orderBy: { id: 'asc' }, select: {
      id: true, slug: true, name: true, price: true, priceQty: true, priceStatus: true,
      unit: true, saleModel: true, priceUnit: true, min: true, step: true, portionQty: true,
      estimatedWeightGrams: true, wholeLabel: true, active: true,
      marketPoint: { select: { slug: true, name: true } }, category: { select: { slug: true } },
      images: { select: { url: true, alt: true, visible: true } },
    } });
  });
  const original: { slug: string; name: string }[] = JSON.parse(await readFile(new URL('./2026-10-18/missing.json', import.meta.url), 'utf8'));
  const missing = products.filter(product => !product.images.length);
  const result = { checkedAt: new Date().toISOString(), localOnly: true, readOnly: true,
    totalProducts: products.length, gramProducts: products.filter(product => product.unit === 'GRAM').length,
    missingImages: missing.length, originalTargets: original.length,
    originalMissing: original.filter(row => missing.some(product => product.slug === row.slug)).length,
    targetIdentityErrors: original.filter(row => !products.some(product => product.slug === row.slug && product.name === row.name)),
    products };
  await writeFile(new URL('./2026-10-18/local-audit.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, products: undefined }));
} finally { await db.$disconnect(); }
