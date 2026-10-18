import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, copyFile, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const api = createRequire(new URL('../../../api/package.json', import.meta.url));
const { tsImport } = api('tsx/esm/api');
const options = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../../../api/tsconfig.json', import.meta.url)) };
const { ImageStorage } = await tsImport('../../../api/src/product/image-storage.ts', options);
const { ImageRegistry } = await tsImport('../../../api/src/product/image-registry.ts', options);
const { imageVariantHandler } = await tsImport('../../../api/src/product/image-static.ts', options);
export { imageVariantHandler };
export const express = createRequire(api.resolve('@nestjs/platform-express'))('express');
const sharp = api('sharp');
const digest = buffer => createHash('sha256').update(buffer).digest('hex');

export async function productImageFixture() {
  const root = await mkdtemp(join(tmpdir(), 'korzina-product-image-web-'));
  const sourceRoot = join(root, 'sources'), publicRoot = join(root, 'public'), stateRoot = join(root, 'state');
  for (const path of [sourceRoot, publicRoot, stateRoot]) await mkdir(path, { mode: 0o700 });
  const input = fileURLToPath(new URL('../../../api/data/product-photos/2026-10-07/domashnie-solenya/domashnie-solenya-salted-tomatoes.webp', import.meta.url));
  const original = { sha256: digest(await readFile(input)), mtime: (await lstat(input, { bigint: true })).mtimeNs };
  const storage = await ImageStorage.open({ sourceRoot, publicRoot, stateRoot });
  const registry = new ImageRegistry({ enabled: true, sourceRoot, publicRoot, stateRoot });
  const images = [];
  for (let index = 0; index < 3; index++) {
    const id = '550e8400-e29b-41d4-a716-' + String(index + 1).padStart(12, '0');
    const path = join(sourceRoot, id + '.webp'), url = '/uploads/products/' + id + '.webp';
    if (index === 0) await copyFile(input, path);
    else await writeFile(path, await sharp(input).resize(index === 1 ? 512 : 72, index === 1 ? 1024 : 48, { fit: 'cover' }).webp().toBuffer(), { flag: 'wx' });
    await storage.save(url);
    const metadata = await registry.metadata(url);
    assert.ok(metadata, 'Fixture must use verified stage 3A metadata');
    images.push({ url, alt: 'Тестовое фото ' + (index + 1), ...metadata });
  }
  return { root, sourceRoot, publicRoot, stateRoot, registry, images,
    async close() {
      assert.equal(digest(await readFile(input)), original.sha256);
      assert.equal((await lstat(input, { bigint: true })).mtimeNs, original.mtime);
      const target = resolve(root);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(target.startsWith(join(resolve(tmpdir()), 'korzina-product-image-web-')));
      await rm(target, { recursive: true, force: true });
    },
  };
}
