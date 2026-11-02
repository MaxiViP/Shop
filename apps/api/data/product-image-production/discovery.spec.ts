import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sourceNames } from './discovery.js';

let root: string;
const original = '550e8400-e29b-41d4-a716-446655440001.webp';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'image-discovery-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('rejects unknown files and directories instead of skipping them', async () => {
  await writeFile(join(root, original), 'source');
  await mkdir(join(root, 'unknown'));
  await expect(sourceNames(root)).rejects.toThrow();
  await rm(join(root, 'unknown'), { recursive: true });
  await writeFile(join(root, 'photo.jpg'), 'unsupported');
  await expect(sourceNames(root)).rejects.toThrow();
});

it('rejects a canonical filename containing a directory', async () => {
  await mkdir(join(root, original));
  await expect(sourceNames(root)).rejects.toMatchObject({ code: 'SOURCE_ALIAS_UNVERIFIED' });
});

it('rejects a file named telegram', async () => {
  await writeFile(join(root, 'telegram'), 'opaque');
  await expect(sourceNames(root)).rejects.toMatchObject({ code: 'TELEGRAM_ROOT_UNSAFE' });
});

it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)(
  'preserves root:root 0755 Telegram media and returns only canonical sources', async () => {
    const media = join(root, 'telegram');
    await mkdir(media, { mode: 0o755 });
    await chmod(media, 0o755);
    await writeFile(join(media, 'existing.jpg'), 'existing Telegram bytes');
    await writeFile(join(root, original), 'source');
    expect(await sourceNames(root)).toEqual([original]);
    expect(await readFile(join(media, 'existing.jpg'), 'utf8')).toBe('existing Telegram bytes');
    await chmod(media, 0o777);
    await expect(sourceNames(root)).rejects.toMatchObject({ code: 'TELEGRAM_ROOT_UNSAFE' });
  },
);

it.skipIf(process.platform !== 'linux')('rejects symlinks and hardlinks', async () => {
  await writeFile(join(root, original), 'source');
  await symlink(root, join(root, 'telegram'));
  await expect(sourceNames(root)).rejects.toMatchObject({ code: 'TELEGRAM_ROOT_UNSAFE' });
  await rm(join(root, 'telegram'));
  await link(join(root, original), join(root, '550e8400-e29b-41d4-a716-446655440002.webp'));
  await expect(sourceNames(root)).rejects.toMatchObject({ code: 'SOURCE_ALIAS_UNVERIFIED' });
});
