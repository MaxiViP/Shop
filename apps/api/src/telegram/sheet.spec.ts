import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { gallerySheet, type GalleryItem } from './sheet.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'telegram-sheet-')); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const item = (index: number): GalleryItem => ({ id: index + 1, name: ['Киви', 'Виноград зелёный', 'Клубника отборная'][index % 3]!,
  price: '1 100 ₽ / 1 кг', image: 'https://shop.example/uploads/products/photo-' + index + '.webp' });
async function photo(index: number, color: string) {
  const data = await sharp({ create: { width: 400, height: 400, channels: 3, background: color } }).webp().toBuffer();
  await writeFile(join(root, 'photo-' + index + '.webp'), data);
  return data;
}
it('renders an exact three-column sheet with stable slots and bounded JPEG, preserving originals', async () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#202020', '#ffffff'];
  const originals = [];
  for (const [index, color] of colors.entries()) originals.push(await photo(index, color));
  const items = colors.map((_, index) => item(index));
  const sheet = await gallerySheet(items, root);
  expect(sheet).toBeDefined(); expect(sheet!.data.length).toBeLessThanOrEqual(1024 * 1024);
  expect(await sharp(sheet!.data).metadata()).toMatchObject({ width: 1112, height: 914, format: 'jpeg' });
  const { data, info } = await sharp(sheet!.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < colors.length; index++) {
    const offset = ((8 + Math.floor(index / 3) * 302 + 93) * info.width + 8 + index % 3 * 368 + 180) * info.channels;
    const expected = colors[index]!.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16));
    expect([...data.subarray(offset, offset + 3)].every((value, channel) => Math.abs(value - expected[channel]!) < 10)).toBe(true);
    expect(await readFile(join(root, 'photo-' + index + '.webp'))).toEqual(originals[index]);
  }
  if (process.env.TELEGRAM_SHEET_PREVIEW) await writeFile(process.env.TELEGRAM_SHEET_PREVIEW, sheet!.data);
});
it('reuses identical preparations and invalidates captions, prices, order and changed image content', async () => {
  await photo(0, '#ff0000'); const items = [item(0), item(1)];
  const first = await gallerySheet(items, root), again = await gallerySheet(items, root);
  expect(again!.key).toBe(first!.key); expect(again!.data).toBe(first!.data);
  for (const changed of [[{ ...items[0]!, price: '1 101 ₽ / 1 кг' }, items[1]!], [{ ...items[0]!, name: 'Киви золотое' }, items[1]!], [...items].reverse()]) {
    const next = await gallerySheet(changed, root);
    expect(next!.key).not.toBe(first!.key); expect(next!.data).not.toEqual(first!.data);
  }
  await photo(0, '#0000ff');
  expect((await gallerySheet(items, root))!.key).not.toBe(first!.key);
});
it('keeps missing/corrupt/private photographs in their original slots and escapes captions without network reads', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await writeFile(join(root, 'bad.webp'), 'invalid');
  const value = await gallerySheet([{ ...item(0), name: '<span foreground="red">'.repeat(5), image: 'https://evil.example/private.jpg' },
    { ...item(1), image: 'https://shop.example/uploads/products/bad.webp' }, item(2)], root);
  expect(value).toBeDefined(); expect(await sharp(value!.data).metadata()).toMatchObject({ width: 1112, height: 310 });
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  expect(await gallerySheet([], root)).toBeUndefined();
  expect(await gallerySheet(Array.from({ length: 9 }, (_, index) => item(index)), root)).toBeUndefined();
});
