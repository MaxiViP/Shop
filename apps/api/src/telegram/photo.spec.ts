import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { localPhoto } from './photo.js';

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
