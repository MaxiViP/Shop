import sharp, { type OverlayOptions } from 'sharp';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { localPhoto, photoVersion } from './photo.js';
import { productUploadRoot } from '../common/image.js';
import { short } from './customer-view.js';
import type { SaleUnit } from '../product/sale.js';

export type CatalogItem = { id: number; name: string; price: number; priceQty: number; priceUnit: SaleUnit;
  priceStatus: string; priceText: string; photo?: string };
type Recipe = { items: (CatalogItem & { version?: string })[]; root: string };
type Rect = { left: number; top: number; width: number; height: number };
type Label = Rect & { text: string };
export type CatalogImage = { bytes: Uint8Array; width: number; height: number;
  panels: { productId: number; photo: Rect; title: Label[]; price: Label; truncated: boolean; placeholder: boolean }[] };
export const catalogGeometry = { width: 960, height: 556, panel: 480, photoHeight: 360, padding: 18, titleTop: 378, line: 40, priceTop: 510 } as const;
const prefix = 'telegram:catalog-pair:v1:';
const recipes = new Map<string, Recipe>(), images = new Map<string, CatalogImage>(), pending = new Map<string, Promise<CatalogImage | undefined>>();
let tail = Promise.resolve(), font: Promise<{ family: string; file: string }> | undefined;
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const isCatalogPhoto = (media: string) => /^telegram:catalog-pair:v1:[a-f0-9]{64}$/.test(media);

async function systemFont() {
  font ??= (async () => {
    const file = process.env.TELEGRAM_FONT_FILE || (process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    await access(file);
    return { file, family: process.platform === 'win32' ? 'Arial' : 'DejaVu Sans' };
  })();
  return font;
}
export async function catalogPair(items: readonly CatalogItem[], root = productUploadRoot): Promise<string> {
  if (!items.length || items.length > 2) throw new Error('CATALOG_PAIR_SIZE');
  const values = await Promise.all(items.map(async item => ({ ...item, version: await photoVersion(item.photo, root) })));
  const media = prefix + createHash('sha256').update(JSON.stringify({ format: 1, root, items: values })).digest('hex');
  recipes.delete(media); recipes.set(media, { items: values, root });
  while (recipes.size > 64) recipes.delete(recipes.keys().next().value!);
  return media;
}
export function catalogCacheStats() {
  return { recipes: recipes.size, images: images.size, bytes: [...images.values()].reduce((sum, image) => sum + image.bytes.length, 0), pending: pending.size };
}
export async function catalogImage(media: string): Promise<CatalogImage | undefined> {
  if (!isCatalogPhoto(media)) return;
  const cached = images.get(media);
  if (cached) { images.delete(media); images.set(media, cached); return cached; }
  const known = pending.get(media); if (known) return known;
  const recipe = recipes.get(media);
  if (!recipe || pending.size >= 8) return;
  const task = tail.then(async () => {
    try {
      const image = await render(recipe);
      images.set(media, image);
      while (images.size > 16 || catalogCacheStats().bytes > 4 * 1024 * 1024) images.delete(images.keys().next().value!);
      return image;
    } catch { return; }
  }).finally(() => { pending.delete(media); });
  pending.set(media, task); tail = task.then(() => {});
  return task;
}

async function render({ items, root }: Recipe): Promise<CatalogImage> {
  const fonts = await systemFont(), g = catalogGeometry, width = g.panel - g.padding * 2;
  const overlays: OverlayOptions[] = [], panels: CatalogImage['panels'] = [];
  const measurements = new Map<string, number>();
  const textImage = (text: string, size: number, bold = false) => sharp({ text: {
    text: (bold ? '<b>' : '') + escape(text) + (bold ? '</b>' : ''), font: fonts.family + ' ' + size,
    fontfile: fonts.file, dpi: 72, rgba: true,
  } });
  const measure = async (text: string, size: number, bold = false) => {
    const key = size + ':' + bold + ':' + text;
    let value = measurements.get(key);
    if (value === undefined) { value = text ? (await textImage(text, size, bold).metadata()).width : 0; measurements.set(key, value); }
    return value;
  };
  const fit = async (parts: string[], suffix = '') => {
    let low = 0, high = parts.length;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (await measure(parts.slice(0, middle).join('') + suffix, 34) <= width) low = middle; else high = middle - 1; }
    return low;
  };
  const label = async (text: string, left: number, top: number, size: number, bold = false, maxHeight = g.height - top): Promise<Label> => {
    let { data, info } = await textImage(text, size, bold).png().toBuffer({ resolveWithObject: true });
    if (info.height > maxHeight) ({ data, info } = await sharp(data).resize({ height: maxHeight, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true }));
    if (info.width > width || top + info.height > g.height || left + info.width > Math.floor(left / g.panel + 1) * g.panel) throw new Error('CATALOG_TEXT_BOUNDS');
    overlays.push({ input: data, left, top }); return { text, left, top, width: info.width, height: info.height };
  };
  for (let column = 0; column < items.length; column++) {
    const item = items[column]!, left = column * g.panel, title: Label[] = [];
    if (await photoVersion(item.photo, root) !== item.version) throw new Error('CATALOG_PHOTO_CHANGED');
    const photo = item.photo && item.version ? await localPhoto(item.photo, root, true) : undefined;
    const photoRect = { left, top: 0, width: g.panel, height: g.photoHeight };
    if (photo) overlays.push({ input: await sharp(photo).resize({ width: g.panel, height: g.photoHeight, fit: 'contain', background: '#ffffff' }).png().toBuffer(), left, top: 0 });
    else {
      overlays.push({ input: await sharp({ create: { width: g.panel, height: g.photoHeight, channels: 3, background: '#f1f3f5' } }).png().toBuffer(), left, top: 0 });
      await label('Нет фото', left + g.padding, 160, 28);
    }
    const name = short(item.name, 1000).replace(/\s+/gu, ' ');
    let rest = [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(name || 'Товар')].map(part => part.segment);
    let truncated = false;
    for (let line = 0; line < 3 && rest.length; line++) {
      let length = await fit(rest), suffix = '';
      if (!length) throw new Error('CATALOG_GLYPH_WIDTH');
      if (length < rest.length && line === 2) { length = await fit(rest, '…'); suffix = '…'; truncated = true; }
      else if (length < rest.length) {
        const boundary = rest.slice(0, length + 1).findLastIndex(part => /\s/u.test(part));
        if (boundary > 0) length = boundary;
      }
      const text = rest.slice(0, length).join('').trimEnd() + suffix;
      title.push(await label(text, left + g.padding, g.titleTop + line * g.line, 34, false, g.line - 2));
      rest = rest.slice(length); while (rest[0] && /\s/u.test(rest[0])) rest.shift();
    }
    let priceSize = 36;
    while (priceSize > 18 && await measure(item.priceText, priceSize, true) > width) priceSize--;
    const price = await label(item.priceText, left + g.padding, g.priceTop, priceSize, true);
    if (await photoVersion(item.photo, root) !== item.version) throw new Error('CATALOG_PHOTO_CHANGED');
    panels.push({ productId: item.id, photo: photoRect, title, price, truncated, placeholder: !photo });
  }
  overlays.push({ input: await sharp({ create: { width: 2, height: g.height, channels: 3, background: '#e5e7eb' } }).png().toBuffer(), left: g.panel - 1, top: 0 });
  const bytes = await sharp({ create: { width: g.width, height: g.height, channels: 3, background: '#ffffff' } })
    .composite(overlays).jpeg({ quality: 88, chromaSubsampling: '4:4:4' }).toBuffer();
  if (bytes.length > 256 * 1024) throw new Error('CATALOG_JPEG_LIMIT');
  return { bytes: new Uint8Array(bytes), width: g.width, height: g.height, panels };
}
