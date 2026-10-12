import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
config({ quiet: true });
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only local verification permitted');
const backup = JSON.parse(await readFile('../../docs/catalog-sale-audit/backup.json', 'utf8'));
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
const bin = 'C:/Program Files/PostgreSQL/18/bin/';
const digest = value => createHash('sha256').update(value).digest('hex');
const checks = [];
for (const table of ['Product', 'ProductImage', 'Category', 'MarketPoint', 'ShopSettings', 'Order', 'OrderItem', 'OrderIssue', 'Cart', 'CartItem']) {
  const old = spawnSync(bin + 'pg_restore.exe', ['--data-only', '--table', table, '--file', '-', backup.file], { env, encoding: 'utf8', maxBuffer: 20_000_000 });
  if (old.status !== 0) throw new Error('Backup verification read failed');
  const match = new RegExp('COPY public\\."?' + table + '"? \\(([^\\n]+)\\) FROM stdin;\\r?\\n([\\s\\S]*?)\\\\\\.').exec(old.stdout);
  if (!match) throw new Error(`Missing backup table ${table}`);
  const columns = match[1].split(', ').map(name => name.replaceAll('"', ''));
  if (columns.some(name => !/^[a-zA-Z0-9_]+$/.test(name))) throw new Error('Unsafe backup column');
  const keep = columns.map((name, index) => ({ name, index })).filter(({ name }) => table !== 'Product' || !['unit', 'updatedAt'].includes(name));
  const oldRows = match[2].trimEnd() ? match[2].trimEnd().split(/\r?\n/).map(row => {
    const cells = row.split('\t');
    if (cells.length !== columns.length) throw new Error('Malformed backup row');
    return keep.map(({ index }) => cells[index]).join('\t');
  }).sort() : [];
  const sql = `COPY (SELECT ${keep.map(({ name }) => `"${name}"`).join(', ')} FROM public."${table}") TO STDOUT`;
  const result = spawnSync(bin + 'psql.exe', ['--no-psqlrc', '--quiet', '--command', sql], { env, encoding: 'utf8', maxBuffer: 20_000_000 });
  if (result.status !== 0) throw new Error('Local verification query failed');
  const rows = result.stdout.trimEnd() ? result.stdout.trimEnd().split(/\r?\n/).sort() : [];
  const beforeHash = digest(oldRows.join('\n'));
  const afterHash = digest(rows.join('\n'));
  checks.push({ table, beforeCount: oldRows.length, afterCount: rows.length, beforeHash, afterHash, preserved: beforeHash === afterHash,
    excludedFields: table === 'Product' ? ['unit', 'updatedAt'] : [] });
}
const plan = JSON.parse(await readFile('../../docs/catalog-sale-audit/plan.json', 'utf8'));
const productUnits = spawnSync(bin + 'psql.exe', ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--command', 'SELECT id, slug, unit, "saleModel", "priceUnit" FROM public."Product" ORDER BY id'], { env, encoding: 'utf8' });
if (productUnits.status !== 0) throw new Error('Unit verification failed');
const rows = productUnits.stdout.trim().split(/\r?\n/).map(row => row.split('|'));
const unitChecks = plan.patches.map(patch => ({ productId: patch.productId, slug: patch.slug,
  applied: rows.some(row => Number(row[0]) === patch.productId && row[1] === patch.slug && row[2] === 'PACK' && row[3] === 'PACK' && row[4] === 'PACK') }));
const summary = { checkedAt: new Date().toISOString(), localOnly: true, checks, unitChecks, passed: checks.every(check => check.preserved) && unitChecks.every(check => check.applied) };
await writeFile('../../docs/catalog-sale-audit/verification.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ passed: summary.passed, tables: checks.map(({ table, beforeCount, afterCount, preserved }) => ({ table, beforeCount, afterCount, preserved })), correctedProducts: unitChecks.filter(row => row.applied).length }, null, 2));
if (!summary.passed) process.exitCode = 1;
