import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { normalizeImage } from '../common/image.js';
import { photoHash, placeholderUrl, readPhotoPack, type PhotoManifest } from './photo-pack.js';
import { managedPath } from '../admin/images.service.js';

let root: string;
let buffer: Buffer;
let manifest: PhotoManifest;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'korzina-photo-pack-test-'));
  buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).webp({ lossless: true }).toBuffer();
  manifest = { kind: 'AI_PLACEHOLDER', batch: '2026-10-07', products: [{
    slug: 'test-point-exact-product', name: 'Test product', marketPointSlug: 'test-point',
    marketPointName: 'Test point', categorySlug: 'fish', priceStatus: 'ESTIMATED', sha256: photoHash(buffer),
  }] };
  await mkdir(join(root, 'test-point'));
  await writeFile(join(root, 'test-point/test-point-exact-product.webp'), buffer);
  await saveManifest();
});
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('korzina-photo-pack-test-')) throw new Error('Unsafe test root');
  await rm(root, { recursive: true, force: true });
});
const saveManifest = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));

it('keeps validated WebP bytes and uses the existing managed UUID URL convention', async () => {
  await writeFile(join(root, 'README.md'), 'Versioned photo pack documentation');
  expect(await normalizeImage({ buffer, size: buffer.length, mimetype: 'image/webp' }, true)).toEqual(buffer);
  const pack = await readPhotoPack(root);
  expect(pack.audit).toMatchObject({ clean: true, sourceProducts: 1, exactMatches: 1, invalidImages: 0 });
  const url = placeholderUrl(manifest.products[0]!, manifest.batch);
  expect(managedPath(url)).not.toBeNull();
  expect(placeholderUrl(manifest.products[0]!, manifest.batch)).toBe(url);
  expect(placeholderUrl({ ...manifest.products[0]!, slug: 'another-product' }, manifest.batch)).not.toBe(url);
  expect(placeholderUrl({ ...manifest.products[0]!, sha256: '0'.repeat(64) }, manifest.batch)).not.toBe(url);
  expect(await readFile(join(root, pack.files[0]!.sourceFile))).toEqual(buffer);
});

it('rejects fuzzy names, wrong point folders, duplicate slugs and extra non-WebP files', async () => {
  await writeFile(join(root, 'test-point/similar-product.webp'), buffer);
  await mkdir(join(root, 'other-point'));
  await writeFile(join(root, 'other-point/test-point-exact-product.webp'), buffer);
  await writeFile(join(root, 'test-point/extra.zip'), 'not an image');
  const result = (await readPhotoPack(root)).audit;
  expect(result).toMatchObject({ clean: false, unknownImages: 1, duplicates: 1, wrongMarketPoint: 1, nonWebpFiles: 1 });
});

it.each(['empty', 'corrupt', 'png', 'changed-bytes'] as const)('rejects %s images before any import', async kind => {
  const file = join(root, 'test-point/test-point-exact-product.webp');
  await writeFile(file, kind === 'empty' ? Buffer.alloc(0) : kind === 'corrupt' ? Buffer.from('RIFFbroken') :
    await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })[kind === 'png' ? 'png' : 'webp']().toBuffer());
  expect((await readPhotoPack(root)).audit).toMatchObject({ clean: false, invalidImages: 1 });
});

it('reports missing files and manifest duplicates without guessing replacements', async () => {
  await rm(join(root, 'test-point/test-point-exact-product.webp'));
  expect((await readPhotoPack(root)).audit).toMatchObject({ clean: false, missingImages: 1, exactMatches: 0 });
  manifest.products.push({ ...manifest.products[0]! });
  await saveManifest();
  expect((await readPhotoPack(root)).audit.duplicates).toBe(1);
});
