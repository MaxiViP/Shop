import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { catalogPair, catalogImage, catalogCacheStats, catalogGeometry, type CatalogItem } from './catalog-photo.js';
let root: string;
const item = (id: number, name = 'Оливки CEZONI чёрные в рассоле 350 г'): CatalogItem => ({ id, name, price: 45000,
  priceQty: 1, priceUnit: 'PACK', priceStatus: 'SOURCE', priceText: '450 ₽/уп.' });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'catalog-pair-')); vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it.each(['Оливки CEZONI чёрные в рассоле 350 г', 'Очень длинное название товара '.repeat(12), 'Сверхдлинноесловобезпробелов'.repeat(12), 'Ёлка Йогурт e\u0301 𐐀'.repeat(12), ('е' + '\u0301'.repeat(8)).repeat(20)])('wraps Unicode titles within three independent measured panel lines: %s', async name => {
  const media = await catalogPair([item(1, name), item(2, 'Второй товар')], root), image = await catalogImage(media);
  expect(image).toBeDefined();
  const meta = await sharp(image!.bytes).metadata();
  expect(meta).toMatchObject({ format: 'jpeg', width: 960, height: 556 }); expect(image!.bytes.length).toBeLessThanOrEqual(256 * 1024);
  for (const [index, panel] of image!.panels.entries()) {
    expect(panel.productId).toBe(index + 1); expect(panel.photo).toEqual({ left: index * 480, top: 0, width: 480, height: 360 });
    expect(panel.title.length).toBeGreaterThan(0); expect(panel.title.length).toBeLessThanOrEqual(3);
    for (const label of [...panel.title, panel.price]) {
      expect(label.left).toBeGreaterThanOrEqual(index * 480 + 18);
      expect(label.left + label.width).toBeLessThanOrEqual((index + 1) * 480 - 18);
      expect(label.top + label.height).toBeLessThanOrEqual(catalogGeometry.height);
    }
    expect(panel.price.text).toBe('450 ₽/уп.'); expect(panel.title.at(-1)!.top + panel.title.at(-1)!.height).toBeLessThan(panel.price.top);
  }
  if (name.length > 100 && !name.includes('\u0301'.repeat(8))) { expect(image!.panels[0]!.truncated).toBe(true); expect(image!.panels[0]!.title.at(-1)!.text).toContain('…'); }
});
it('contains the complete photograph inside each4:3 area, leaves odd slots empty, and never changes originals', async () => {
  const source = await sharp({ create: { width: 900, height: 1600, channels: 3, background: '#f00' } }).webp().toBuffer();
  await writeFile(join(root, 'portrait.webp'), source);
  const record = { ...item(9), photo: 'https://shop.example/uploads/products/portrait.webp' };
  const image = await catalogImage(await catalogPair([record], root));
  expect(image?.panels).toHaveLength(1); expect(image!.panels[0]!.placeholder).toBe(false);
  expect(await readFile(join(root, 'portrait.webp'))).toEqual(source);
  const right = await sharp(await sharp(image!.bytes).extract({ left: 500, top: 20, width: 440, height: 516 }).toBuffer()).stats();
  expect(right.channels.slice(0, 3).every(channel => channel.min >= 250)).toBe(true);
  expect(image!.panels[0]!.photo.width * 3).toBe(image!.panels[0]!.photo.height * 4);
});
it('keys every product, order, label, server price field and image revision, and shares concurrent rasterization', async () => {
  const a = item(21), b = item(22), first = await catalogPair([a, b], root);
  expect(await catalogPair([a, b], root)).toBe(first);
  for (const changed of [{ ...a, id: 23 }, { ...a, name: a.name + ' другой' }, { ...a, price: 45100 },
    { ...a, priceQty: 2 }, { ...a, priceUnit: 'GRAM' as const }, { ...a, priceStatus: 'ESTIMATED' }, { ...a, priceText: '451 ₽/уп.' }])
    expect(await catalogPair([changed, b], root)).not.toBe(first);
  expect(await catalogPair([b, a], root)).not.toBe(first);
  const [one, two] = await Promise.all([catalogImage(first), catalogImage(first)]); expect(one).toBe(two); expect(one).toBeDefined();
  const path = join(root, 'mutable.png'), photo = 'https://shop.example/uploads/products/mutable.png';
  await writeFile(path, await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } }).png().toBuffer());
  const old = await catalogPair([{ ...a, photo }], root);
  await writeFile(path, await sharp({ create: { width: 40, height: 30, channels: 3, background: '#00f' } }).png().toBuffer());
  expect(await catalogPair([{ ...a, photo }], root)).not.toBe(old);
  expect(await catalogImage(old)).toBeUndefined();
});
it('uses a per-product placeholder for corrupt/missing/foreign files without fetching a URL or rendering markup', async () => {
  await writeFile(join(root, 'bad.png'), 'not an image');
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const image = await catalogImage(await catalogPair([{ ...item(30, '<b>& Ёжик</b>'), photo: 'https://shop.example/uploads/products/bad.png' },
    { ...item(31), photo: 'https://evil.example/private.png' }], root));
  expect(image?.panels.every(panel => panel.placeholder)).toBe(true); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  expect(image!.panels[0]!.title.map(line => line.text).join(' ')).toContain('<b>&');
});
it('bounds caches and generation queue under parallel page requests', async () => {
  const refs = await Promise.all(Array.from({ length: 70 }, (_, index) => catalogPair([item(1000 + index)], root)));
  const renders = await Promise.all(refs.slice(-16).map(media => catalogImage(media)));
  expect(renders.filter(Boolean).length).toBeGreaterThan(0);
  const state = catalogCacheStats(); expect(state.recipes).toBeLessThanOrEqual(64); expect(state.images).toBeLessThanOrEqual(16);
  expect(state.bytes).toBeLessThanOrEqual(4 * 1024 * 1024); expect(state.pending).toBe(0);
  expect(await catalogImage('telegram:catalog-pair:v1:invalid')).toBeUndefined();
});
it('keeps two different source photographs in their ordered product panels and preserves full large prices', async () => {
  for (const [name, color] of [['red', '#ff0000'], ['blue', '#0000ff']]) await writeFile(join(root, name + '.png'),
    await sharp({ create: { width: 480, height: 360, channels: 3, background: color! } }).png().toBuffer());
  const priceText = '≈1 000 000,99 ₽/1 000 000 пучков';
  const first = { ...item(200), priceText, photo: 'https://shop.example/uploads/products/red.png' };
  const second = { ...item(201), photo: 'https://shop.example/uploads/products/blue.png' };
  const image = await catalogImage(await catalogPair([first, second], root)); expect(image).toBeDefined();
  for (const [left, channel] of [[200, 0], [680, 2]]) {
    const pixels = await sharp(image!.bytes).extract({ left: left!, top: 140, width: 40, height: 40 }).raw().toBuffer();
    expect(pixels[channel!]).toBeGreaterThan(230); expect(pixels[channel === 0 ? 2 : 0]).toBeLessThan(20);
  }
  expect(image!.panels.map(panel => panel.productId)).toEqual([200, 201]);
  expect(image!.panels[0]!.price.text).toBe(priceText); expect(image!.panels[0]!.price.width).toBeLessThanOrEqual(444);
});
