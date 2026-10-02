import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ChatImagesService, assertChatFreeBytes, chatIncomingRoot, MAX_CHAT_RAW } from './chat-images.service.js';

let root = '';
const images = new ChatImagesService();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'shop-chat-unit-'));
  vi.stubEnv('CHAT_UPLOAD_DIR', root);
  await mkdir(chatIncomingRoot(), { recursive: true });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!/^shop-chat-unit-[^\\/]+$/.test(relative(tmpdir(), root)))
    throw new Error('Unsafe test directory');
  await rm(root, { recursive: true, force: true });
});

async function stage(buffer: Buffer, mimetype: string) {
  const filename = randomBytes(16).toString('hex');
  const path = join(chatIncomingRoot(), filename);
  await writeFile(path, buffer);
  return { path, filename, size: buffer.length, mimetype };
}

it('rejects low free space, raw over-limit, invalid MIME and magic', async () => {
  expect(() => assertChatFreeBytes(10n * 1024n ** 3n)).not.toThrow();
  expect(() => assertChatFreeBytes(10n * 1024n ** 3n - 1n)).toThrow();
  try { assertChatFreeBytes(0n); } catch (error) {
    expect(error).toMatchObject({ status: 507 });
  }
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await expect(images.save({ ...await stage(png, 'image/png'), size: MAX_CHAT_RAW + 1 })).rejects.toThrow(/20 МБ/);
  await expect(images.save(await stage(png, 'image/heic'))).rejects.toThrow(/HEIC/);
  await expect(images.save(await stage(png, 'image/svg+xml'))).rejects.toThrow(/JPEG/);
  await expect(images.save(await stage(png, 'image/jpeg'))).rejects.toThrow(/Содержимое/);
});

it('rejects declared images above 60 MP before decoding', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  png.writeUInt32BE(10_000, 16);
  png.writeUInt32BE(7_000, 20);
  let crc = 0xffffffff;
  for (const byte of png.subarray(12, 29)) {
    crc ^= byte;
    for (let index = 0; index < 8; index++)
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  await expect(images.save(await stage(png, 'image/png'))).rejects.toThrow(/60 мегапикселей/);
});

it('normalizes full and thumbnail, strips EXIF and rejects filesystem keys', async () => {
  const jpeg = await sharp({ create: { width: 4200, height: 1200, channels: 3, background: '#f43f5e' } })
    .jpeg().withExif({ IFD0: { ImageDescription: 'PRIVATE-GPS-MARKER' } }).toBuffer();
  const file = await stage(jpeg, 'image/jpeg');
  const key = await images.save(file);
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  const full = await images.read(key, 'full');
  const thumb = await images.read(key, 'thumb');
  expect(await sharp(full).metadata()).toMatchObject({ format: 'webp', width: 4096 });
  expect(await sharp(thumb).metadata()).toMatchObject({ format: 'webp', width: 960 });
  expect((await sharp(full).metadata()).exif).toBeUndefined();
  expect(full.includes(Buffer.from('PRIVATE-GPS-MARKER'))).toBe(false);
  await expect(images.read('../outside', 'full')).rejects.toThrow();
  await expect(images.remove('../outside')).rejects.toThrow();
  await images.remove(key);
  await images.remove(key);
  await expect(images.read(key, 'full')).rejects.toMatchObject({ status: 410 });
  await images.removeTemp(file);
  await images.removeTemp(file);
  expect(await readFile(file.path).catch(() => null)).toBeNull();
  await expect(images.removeTemp({ ...file, path: join(chatIncomingRoot(), '..', file.filename) })).rejects.toThrow(/Недопустимый файл/);
  await expect(images.removeTemp({ ...file, filename: '../outside' })).rejects.toThrow(/Недопустимый файл/);
});
