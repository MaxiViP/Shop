import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { localPhoto } from './photo.js';
import { galleryPlaceholder } from './rich.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'telegram-photo-')); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('prepares a bounded JPEG for Telegram without changing source WebP, reusing concurrent work', async () => {
  const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#12a080' } }).webp().toBuffer();
  await writeFile(join(root, 'fixture.webp'), source);
  const [first, second] = await Promise.all([localPhoto('https://shop.example/uploads/products/fixture.webp', root), localPhoto('https://shop.example/uploads/products/fixture.webp', root)]);
  expect(first).toBeDefined(); expect(first).toBe(second);
  const meta = await sharp(first!).metadata();
  expect(meta.format).toBe('jpeg'); expect(meta.width).toBe(1280);
  expect(first!.length).toBeLessThan(1024 * 1024);
  expect(await readFile(join(root, 'fixture.webp'))).toEqual(source);
});
it('ignores non-local, private, credential and traversal URLs without any network fetch', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const path of ['https://evil.example/uploads/products/fixture.webp', 'https://shop.example/uploads/products/%2e%2e/private.webp',
    'https://user:secret@shop.example/uploads/products/fixture.webp', 'https://shop.example/uploads/products/fixture.webp?secret=1',
    'https://shop.example/api/auth/me']) expect(await localPhoto(path, root)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
});
it('treats absent, invalid and oversized sources as unavailable', async () => {
  expect(await localPhoto('https://shop.example/uploads/products/missing.webp', root)).toBeUndefined();
  await writeFile(join(root, 'invalid.webp'), Buffer.from('not an image'));
  expect(await localPhoto('https://shop.example/uploads/products/invalid.webp', root)).toBeUndefined();
  await writeFile(join(root, 'oversized.webp'), Buffer.alloc(5 * 1024 * 1024 + 1));
  expect(await localPhoto('https://shop.example/uploads/products/oversized.webp', root)).toBeUndefined();
});
it('keeps a cached neutral 4:3 slot for odd/missing collage photos without files or remote fetching', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const [first, second] = await Promise.all([localPhoto(galleryPlaceholder, root, true), localPhoto(galleryPlaceholder, root, true)]);
  expect(first).toBe(second);
  expect(await sharp(first!).metadata()).toMatchObject({ format: 'jpeg', width: 640, height: 480 });
  expect(first!.length).toBeLessThan(192 * 1024);
  expect(await localPhoto(galleryPlaceholder, root)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
});
it('changes gallery geometry to 4:3 while keeping the full product preparation separate', async () => {
  await writeFile(join(root, 'gallery.webp'), await sharp({ create: { width: 1800, height: 900, channels: 3, background: '#12a080' } }).webp().toBuffer());
  const url = 'https://shop.example/uploads/products/gallery.webp';
  const thumbnail = await localPhoto(url, root, true), full = await localPhoto(url, root);
  const meta = await sharp(thumbnail!).metadata();
  expect(meta.width).toBe(640); expect(meta.height).toBe(480); expect(meta.format).toBe('jpeg');
  expect(meta.height! / meta.width!).toBe(0.75); // 25% lower than a square at the same rendered width.
  expect(await sharp(full!).metadata()).toMatchObject({ width: 1280, height: 640 });
  expect(thumbnail!.length).toBeLessThanOrEqual(192 * 1024); expect(thumbnail).not.toBe(full);
});
it.each([[1200, 1200], [1200, 1800], [1800, 900]])('preserves the entire %sx%s product inside a landscape gallery frame', async (width, height) => {
  const source = await sharp({ create: { width, height, channels: 3, background: '#12a080' } }).webp().toBuffer();
  await writeFile(join(root, 'contained.webp'), source);
  const photo = await localPhoto('https://shop.example/uploads/products/contained.webp', root, true);
  const { data, info } = await sharp(photo!).raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 640, height: 480 });
  const green = (x: number, y: number) => data[(y * info.width + x) * info.channels + 1]!;
  // A wide image touches both horizontal edges; square/portrait images touch both vertical edges.
  const edges = width / height >= 4 / 3 ? [[1, 240], [638, 240]] : [[320, 1], [320, 478]];
  for (const [x, y] of edges) expect(green(x!, y!)).toBeLessThan(220);
  expect(data[0]).toBeGreaterThan(240); // Contain padding, not a crop or stretched product.
  expect(await readFile(join(root, 'contained.webp'))).toEqual(source);
});
