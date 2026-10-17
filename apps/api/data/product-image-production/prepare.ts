// Fixed-root, read-only discovery inside the same Linux sandbox as the runner.
// Upload/import keep writing originals only. No queue or HTTP encoder is needed.
import { mkdtemp, opendir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ImageStorage } from '../../src/product/image-storage.js';
import { productImageId } from '../../src/product/image-manifest.js';
import { dryRun } from './runner.js';
import { batchSchema, jsonBytes, RunnerError, type Entry } from './model.js';

sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 50 });
const size = batchSchema.parse(Number(process.argv[2]));
const after = process.argv[3] ?? '';
const only = process.argv[4] ?? '';
if (only) productImageId('/uploads/products/' + only);
if (![4, 5].includes(process.argv.length) || (after && !/^[a-f0-9-]{36}\.webp$/.test(after)))
  throw new RunnerError('INVALID_OPTIONS');
const roots = {
  sourceRoot: '/storage/products',
  variantsRoot: '/storage/product-variants',
  stateRoot: '/storage/.product-image-state',
};
const storage = await ImageStorage.open({
  sourceRoot: roots.sourceRoot, publicRoot: roots.variantsRoot, stateRoot: roots.stateRoot,
});
const names: string[] = [];
for await (const file of await opendir(roots.sourceRoot)) {
  if (names.length >= 100_000) throw new RunnerError('SOURCE_SCAN_LIMIT');
  productImageId('/uploads/products/' + file.name);
  names.push(file.name);
}
names.sort();
const pending: Entry[] = [];
let next = '', scanned = 0;
for (const name of names) {
  if (name <= after || (only && name !== only)) continue;
  if (scanned === 200 || pending.length === size) break;
  next = name;
  scanned++;
  const url = '/uploads/products/' + name;
  const result = await storage.inspect(url);
  if (!result.manifest) {
    const { bytes, sha256, fingerprint } = result.source;
    pending.push({ schemaVersion: 1, url, source: { bytes, sha256, fingerprint } });
  }
}
if (next === names.at(-1) || !scanned) next = '';
const count = [50, 20, 5, 1].find((value) => value <= pending.length);
if (!count) console.log('IMAGE_PREPARE=' + JSON.stringify({ next, scanned, batch: null }));
else {
  const inventory = pending.slice(0, count).map((entry) => JSON.stringify(entry) + '\n').join('');
  const directory = await mkdtemp('/tmp/image-inventory-');
  const path = directory + '/inventory.jsonl';
  await writeFile(path, inventory, { flag: 'wx', mode: 0o600 });
  const report = await dryRun({ apply: false, ...roots, inventory: path, batchSize: batchSchema.parse(count) });
  console.log('IMAGE_PREPARE=' + jsonBytes({ next, scanned, batch: { inventory, proposal: report.proposal } }).toString().trim());
}
