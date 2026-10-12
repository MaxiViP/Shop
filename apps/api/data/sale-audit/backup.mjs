import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
config({ quiet: true });
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only local database backup is allowed');
const file = resolve(tmpdir(), `shop-sale-audit-${Date.now()}.dump`);
const result = spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_dump.exe', ['--format=custom', '--file', file], {
  env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) }, encoding: 'utf8',
});
if (result.status !== 0) throw new Error('Local pg_dump failed; no migration permitted');
const info = await stat(file);
if (info.size < 1000) throw new Error('Backup is empty; no migration permitted');
const metadata = { checkedAt: new Date().toISOString(), localOnly: true, format: 'pg_dump custom', file, bytes: info.size };
await writeFile('../../docs/catalog-sale-audit/backup.json', JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata));
