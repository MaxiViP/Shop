import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../../../../', import.meta.url);
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => !['--apply', '--dry-run'].includes(arg)) || (apply && process.argv.includes('--dry-run'))) throw new Error('Use --dry-run (default) or --apply');
const audit = JSON.parse(await readFile(new URL('docs/catalog-sale-audit/products.json', root), 'utf8'));
const replacements = [
  ['apps/api/data/market-products/types.ts', "unit: 'GRAM' | 'PIECE';", "unit: 'GRAM' | 'PIECE' | 'BUNCH' | 'PACK';\n  saleModel?: 'PACK';\n  priceUnit?: 'PACK';"],
  ['apps/api/data/market-products/2026-10-06.ts', "unit: 'PIECE' as const, priceQty: 1", "unit: marketPointSlug === 'cezoni-market' ? 'PACK' as const : 'PIECE' as const,\n    ...(marketPointSlug === 'cezoni-market' ? { saleModel: 'PACK' as const, priceUnit: 'PACK' as const } : {}), priceQty: 1"],
];
const changes = [];
const writes = [];
for (const [file, before, after] of replacements) {
  const text = await readFile(new URL(file, root), 'utf8');
  if (text.includes(after)) { changes.push({ file, action: 'UNCHANGED' }); continue; }
  if (text.split(before).length !== 2) throw new Error(`Expected exactly one original fragment in ${file}`);
  const next = text.replace(before, after);
  const hash = createHash('sha256').update(text).digest('hex');
  const nextHash = createHash('sha256').update(next).digest('hex');
  // A refreshed report may describe the already patched file. Verify the exact transformation too.
  if (![hash, nextHash].includes(audit.fileChecksums[file])) { changes.push({ file, action: 'SKIPPED_FILE_CHANGED' }); continue; }
  changes.push({ file, action: apply ? 'APPLY' : 'WOULD_APPLY', before, after });
  writes.push([file, next]);
}
console.log(JSON.stringify({ apply, phase: 'BEFORE_WRITE', changes }, null, 2));
if (apply) for (const [file, content] of writes) await writeFile(new URL(file, root), content);
await writeFile(new URL(`docs/catalog-sale-audit/files-${apply ? 'apply' : 'dry-run'}.json`, root), JSON.stringify({ apply, changes }, null, 2) + '\n');
