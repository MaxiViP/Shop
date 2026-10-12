import { config } from 'dotenv';
import pg from 'pg';
import { access, mkdir, writeFile } from 'node:fs/promises';

config({ quiet: true });
const url = process.env.DATABASE_URL;
const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
const report = { checkedAt: new Date().toISOString(), local: Boolean(local), available: false };
if (local) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT p.id, p.slug, p.name, p.description, p.unit, p."priceQty", p.min, p.step, p."portionQty", p.active, p.price, p."priceStatus", p."sourceUrl", p."sourceCheckedAt" AT TIME ZONE 'UTC' AS "sourceCheckedAt", p."updatedAt" AT TIME ZONE 'UTC' AS "updatedAt", p."categoryId", p."marketPointId", c.slug AS "categorySlug", c.name AS "categoryName", m.slug AS "marketPointSlug", m.name AS "marketPointName" FROM "Product" p JOIN "Category" c ON c.id = p."categoryId" LEFT JOIN "MarketPoint" m ON m.id = p."marketPointId" ORDER BY p.id`);
    report.available = true;
    report.products = rows;
    report.count = rows.length;
    report.activeCount = rows.filter(row => row.active).length;
  } catch (error) {
    report.errorCode = error.code ?? 'CONNECTION_FAILED';
  } finally { await client.end(); }
}
await mkdir('../../docs/catalog-sale-audit', { recursive: true });
const baseline = '../../docs/catalog-sale-audit/database.json';
const exists = await access(baseline).then(() => true, () => false);
await writeFile(exists ? '../../docs/catalog-sale-audit/database-current.json' : baseline, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, products: undefined }));
