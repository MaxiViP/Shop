import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  lstat,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { ImageRegistryOptions } from '../../src/product/image-config.js';
import { hash, ImageStorage } from '../../src/product/image-storage.js';

export const imageId = (index = 1) =>
  '550e8400-e29b-41d4-a716-' + index.toString().padStart(12, '0');
export const imageUrl = (index = 1) =>
  '/uploads/products/' + imageId(index) + '.webp';

export async function imageFixture(separate = false) {
  const root = await mkdtemp(join(tmpdir(), 'korzina-image-api-test-'));
  const sourceRoot = join(root, 'products');
  const publicRoot = separate ? join(root, 'public') : sourceRoot;
  const stateRoot = join(root, 'state');
  for (const path of new Set([
    sourceRoot,
    publicRoot,
    stateRoot,
    join(root, 'outside'),
  ]))
    await mkdir(path, { mode: 0o700 });
  await writeFile(
    join(root, 'outside', 'secret.json'),
    '{"private":"never serve"}',
  );
  const source = await sharp({
    create: { width: 960, height: 720, channels: 3, background: '#5a83ad' },
  })
    .webp()
    .toBuffer();
  const storage = await ImageStorage.open({
    publicRoot,
    stateRoot,
    ...(separate ? { sourceRoot } : {}),
  });
  const add = async (index: number) => {
    await writeFile(join(sourceRoot, imageId(index) + '.webp'), source, {
      flag: 'wx',
    });
    return (await storage.save(imageUrl(index))).manifest;
  };
  const manifest = await add(1);
  return {
    root,
    sourceRoot,
    publicRoot,
    stateRoot,
    source,
    storage,
    manifest,
    add,
    original: join(sourceRoot, imageId() + '.webp'),
    ready: join(stateRoot, 'ready', imageId() + '.json'),
    path: (url: string) =>
      join(publicRoot, ...url.slice('/uploads/products/'.length).split('/')),
    options: {
      enabled: true,
      sourceRoot,
      publicRoot,
      stateRoot,
    } satisfies ImageRegistryOptions,
    async close() {
      const target = resolve(root);
      assertFixtureRoot(target);
      await rm(target, { recursive: true, force: true });
    },
  };
}
function assertFixtureRoot(target: string) {
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.startsWith(resolve(tmpdir()) + sep + 'korzina-image-api-test-')
  )
    throw new Error('Unsafe image fixture cleanup');
}
export type ImageFixture = Awaited<ReturnType<typeof imageFixture>>;
export async function imageTree(path: string): Promise<unknown[]> {
  const info = await lstat(path, { bigint: true });
  const result: unknown[] = [
    path,
    String(info.ino),
    String(info.mtimeNs),
    String(info.size),
  ];
  if (info.isFile()) result.push(hash(await readFile(path)));
  if (info.isDirectory() && !info.isSymbolicLink())
    for (const name of (await readdir(path)).sort())
      result.push(await imageTree(join(path, name)));
  return result;
}
