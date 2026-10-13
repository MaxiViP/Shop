// Read repository samples; encode proposals in memory only. Never changes originals/uploads.
import { createRequire } from 'node:module';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sharp = createRequire(new URL('../apps/api/package.json', import.meta.url))('sharp');
const root = 'apps/api/data/product-photos/2026-10-07';
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name))
    : /\.webp$/i.test(entry.name) ? [join(path, entry.name)] : []))).flat();
}
const paths = await files(root);
const originals = [];
for (const path of paths) {
  const meta = await sharp(path).metadata();
  originals.push({ path, bytes: (await stat(path)).size, width: meta.width, height: meta.height, format: meta.format });
}
const samples = originals.toSorted((a, b) => b.bytes - a.bytes).slice(0, 12);
for (const sample of samples) {
  sample.proposed = [];
  for (const width of [192, 384, 640]) {
    const { data, info } = await sharp(sample.path).rotate().resize({ width, withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    sample.proposed.push({ width: info.width, height: info.height, format: info.format, bytes: data.length });
  }
}
const result = { conditions: 'Repository import pack, 12 largest files; WebP quality 85; no production samples; proposals only, originals untouched. Visual acceptance and DPR tests still required.', count: originals.length, totalBytes: originals.reduce((sum, file) => sum + file.bytes, 0), originals, samples };
await writeFile(process.argv[2] ?? 'work/performance/image-audit.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ count: result.count, bytes: result.totalBytes, samples: samples.map(({ path, bytes, width, height, proposed }) => ({ path, bytes, width, height, proposed })) }));
