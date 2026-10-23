import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import sharp from 'sharp';
import { productUploadRoot } from '../common/image.js';
import { productPhoto } from './rich.js';
import { mediaDiagnostic } from './media.js';

const prepared = new Map<string, Promise<Uint8Array>>();
// Telegram-only in-memory JPEG derivative. Never modifies source WebP or image-runner state.
export async function localPhoto(url: string, root = productUploadRoot, thumbnail = false): Promise<Uint8Array | undefined> {
  if (!productPhoto(url)) return;
  const match = /^\/uploads\/products\/([A-Za-z0-9_-]{1,128}\.(?:webp|png|jpe?g))$/.exec(new URL(url).pathname);
  if (!match) return;
  try {
    const base = await realpath(root), file = resolve(base, match[1]!);
    const info = await lstat(file);
    if (!info.isFile() || info.size < 1 || info.size > 5 * 1024 * 1024 || !(await realpath(file)).startsWith(base + sep)) return;
    const key = file + ':' + info.mtimeMs + ':' + info.ctimeMs + ':' + info.size + ':' + thumbnail;
    let task = prepared.get(key);
    if (!task) {
      task = (async () => {
        const source = await readFile(file);
        if (source.length > 5 * 1024 * 1024) throw new Error('PHOTO_LIMIT');
        const image = sharp(source, { limitInputPixels: 25_000_000, failOn: 'warning' });
        const meta = await image.metadata();
        if ((meta.pages ?? 1) !== 1) throw new Error('PHOTO_PAGES');
        // Aspect ratio, rather than JPEG resolution, controls the height offered to Telegram's collage layout.
        // Contain preserves the entire product; full product cards keep their existing proportions.
        const jpeg = await image.rotate().resize({ width: thumbnail ? 640 : 1280, height: thumbnail ? 480 : 1280,
          fit: thumbnail ? 'contain' : 'inside', withoutEnlargement: true, background: '#ffffff' })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
        if (jpeg.length > (thumbnail ? 192 : 1024) * 1024) throw new Error('PHOTO_LIMIT');
        return new Uint8Array(jpeg);
      })();
      prepared.set(key, task);
      while (prepared.size > 16) prepared.delete(prepared.keys().next().value!);
      void task.catch(() => prepared.delete(key));
    }
    return await task;
  } catch { mediaDiagnostic('no_image'); return; }
}
