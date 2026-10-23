import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { localPhoto } from './photo.js';
import { mediaDiagnostic } from './media.js';

export type GalleryItem = { id: number; name: string; price: string; image?: string };
const fontfile = resolve(import.meta.dirname, '../../assets/Roboto.ttf');
const cache = new Map<string, Promise<Uint8Array>>();
const escape = (text: string) => Array.from(text).map(char => char.charCodeAt(0) < 32 ? ' ' : char).join('')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
async function label(text: string, width: number, height: number, size: number, bold = false) {
  return sharp({ text: { text: '<span foreground="white"' + (bold ? ' weight="bold"' : '') + '>' + escape(text) + '</span>',
    font: 'Roboto ' + size, fontfile, width, wrap: 'word-char', rgba: true } })
    .resize({ width, height, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

// One deterministic image fixes the three-column layout independently of Telegram's collage renderer.
export async function gallerySheet(items: readonly GalleryItem[], root?: string): Promise<{ key: string; data: Uint8Array } | undefined> {
  if (!items.length || items.length > 8) return;
  try {
    const photos: (Uint8Array | undefined)[] = [];
    for (const item of items) photos.push(item.image ? await localPhoto(item.image, root, true) : undefined);
    const digest = createHash('sha256').update('sheet-v1:360x294:Roboto:3columns').update(JSON.stringify(items));
    for (const photo of photos) digest.update(photo ? createHash('sha256').update(photo).digest() : 'missing');
    const key = 'sheet:' + digest.digest('hex');
    let task = cache.get(key);
    if (!task) {
      task = (async () => {
        const columns = Math.min(3, items.length), width = columns * 368 + 8, height = Math.ceil(items.length / columns) * 302 + 8;
        const tiles: OverlayOptions[] = [];
        for (const [index, item] of items.entries()) {
          const background = Buffer.from('<svg width="360" height="294"><rect width="360" height="294" fill="#53685a"/><rect y="186" width="360" height="108" fill="#173e2d"/></svg>');
          const layers: OverlayOptions[] = [];
          if (photos[index]) layers.push({ input: await sharp(photos[index]).resize(360, 186, { fit: 'cover' }).png().toBuffer(), top: 0, left: 0 });
          else layers.push({ input: await label('Нет фото', 180, 40, 28), top: 74, left: 90 });
          layers.push({ input: Buffer.from('<svg width="40" height="40"><rect width="40" height="40" rx="10" fill="#173e2d"/></svg>'), top: 10, left: 10 },
            { input: await label(String(index + 1), 28, 32, 28, true), top: 15, left: 22 },
            { input: await label(Array.from(item.name).slice(0, 46).join('') + (Array.from(item.name).length > 46 ? '…' : ''), 336, 60, 28), top: 195, left: 12 },
            { input: await label(item.price, 336, 30, 30, true), top: 259, left: 12 });
          const input = await sharp(background).composite(layers).png().toBuffer();
          tiles.push({ input, left: 8 + (index % columns) * 368, top: 8 + Math.floor(index / columns) * 302 });
        }
        const data = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(tiles).jpeg({ quality: 88 }).toBuffer();
        if (data.length > 1024 * 1024) throw new Error('SHEET_LIMIT');
        return new Uint8Array(data);
      })();
      cache.set(key, task);
      while (cache.size > 16) cache.delete(cache.keys().next().value!);
      void task.catch(() => cache.delete(key));
    }
    return { key, data: await task };
  } catch { mediaDiagnostic('fallback_used'); return; }
}
