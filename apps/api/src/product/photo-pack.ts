import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { normalizeImage } from '../common/image.js';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180);
export const photoManifestSchema = z.strictObject({
  kind: z.literal('AI_PLACEHOLDER'),
  batch: z.literal('2026-10-07'),
  products: z.array(z.strictObject({
    slug, name: z.string().min(1).max(160), marketPointSlug: slug,
    marketPointName: z.string().min(1).max(160), categorySlug: slug,
    priceStatus: z.enum(['ESTIMATED', 'SOURCE', 'AUDITED']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(146),
});
export type PhotoManifest = z.infer<typeof photoManifestSchema>;
export const photoHash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

export async function readPhotoPack(root: string) {
  const manifest = photoManifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  const directories: string[] = [], files: string[] = [], unsupported: string[] = [];
  async function scan(folder = '') {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { directories.push(relative); await scan(relative); }
      else if (entry.isFile() && !['manifest.json', 'README.md'].includes(relative)) files.push(relative);
      else if (!entry.isFile()) unsupported.push(relative);
    }
  }
  await scan();
  const expectedPoints = new Set(manifest.products.map(row => row.marketPointSlug));
  const folders = directories.filter(dir => !dir.includes('/'));
  const wrongFolders = directories.filter(dir => dir.includes('/') || !expectedPoints.has(dir));
  const missingFolders = [...expectedPoints].filter(point => !folders.includes(point));
  const images = files.filter(file => extname(file) === '.webp');
  const nonWebp = files.filter(file => extname(file) !== '.webp');
  const products = new Map(manifest.products.map(row => [row.slug, row]));
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const row of manifest.products) {
    if (seen.has(row.slug)) duplicates.add(row.slug);
    seen.add(row.slug);
  }
  seen.clear();
  const unknown: string[] = [], wrongPoint: string[] = [], matched = new Set<string>();
  const invalid: { file: string; error: string }[] = [];
  const validFiles: { product: PhotoManifest['products'][number]; sourceFile: string; buffer: Buffer }[] = [];
  for (const file of images) {
    const productSlug = basename(file, '.webp');
    if (seen.has(productSlug)) duplicates.add(productSlug);
    seen.add(productSlug);
    const product = products.get(productSlug);
    if (!product) unknown.push(file);
    else if (file !== `${product.marketPointSlug}/${product.slug}.webp`) wrongPoint.push(file);
    else matched.add(productSlug);
    try {
      const buffer = await readFile(join(root, file));
      await normalizeImage({ buffer, size: buffer.length, mimetype: 'image/webp' }, true);
      if (product && photoHash(buffer) !== product.sha256) throw new Error('SHA-256 не совпадает с manifest');
      if (product) validFiles.push({ product, sourceFile: file, buffer });
    } catch (error) {
      invalid.push({ file, error: error instanceof Error ? error.message : 'Невалидное изображение' });
    }
  }
  const missing = manifest.products.filter(row => !matched.has(row.slug)).map(row => row.slug);
  const audit = {
    sourceProducts: manifest.products.length, marketPointFolders: folders.length, imageFiles: images.length,
    exactMatches: matched.size, unknownImages: unknown.length, missingImages: missing.length,
    duplicates: duplicates.size, wrongMarketPoint: wrongPoint.length, invalidImages: invalid.length,
    nonWebpFiles: nonWebp.length,
    clean: !unknown.length && !missing.length && !duplicates.size && !wrongPoint.length && !invalid.length
      && !nonWebp.length && !wrongFolders.length && !missingFolders.length && !unsupported.length,
    details: { unknown, missing, duplicates: [...duplicates], wrongPoint, invalid, nonWebp,
      wrongFolders, missingFolders, unsupported },
  };
  return { manifest, audit, files: validFiles };
}
export type PhotoPack = Awaited<ReturnType<typeof readPhotoPack>>;

export function placeholderUrl(product: PhotoManifest['products'][number], batch: PhotoManifest['batch']) {
  const bytes = createHash('sha256').update(`KorzinaMarket:AI_PLACEHOLDER:${batch}:${product.slug}:${product.sha256}`).digest();
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `/uploads/products/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.webp`;
}
