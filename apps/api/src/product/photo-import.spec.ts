import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '../db/gen/client.js';
import { readPhotoPack } from './photo-pack.js';

it('imports the new real WebP pack safely, repeats without duplicates and preserves existing photos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'korzina-photo-batch-test-'));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('korzina-photo-batch-test-')) throw new Error('Unsafe test directory');
  vi.stubEnv('UPLOAD_DIR', root);
  vi.resetModules();
  const { importProductPhotos, validateProductPhotos } = await import('./photo-import.js');
  const { managedPath } = await import('../admin/images.service.js');
  try {
    const pack = await readPhotoPack(fileURLToPath(new URL('../../data/product-photos/2026-10-18/pack/', import.meta.url)));
    expect(pack.audit.clean).toBe(true);
    const products = pack.files.map((file, index) => ({ id: index + 1, slug: file.product.slug,
      name: file.product.name, marketPoint: { slug: file.product.marketPointSlug },
      images: [] as { id: number; url: string; visible: boolean; productId: number }[] }));
    const existing = { id: 100, url: '/uploads/products/real-photo.webp', visible: false, productId: 1 };
    products[0]!.images.push(existing);
    const tx = {
      $executeRaw: vi.fn(), $queryRaw: vi.fn(),
      product: { findMany: vi.fn(async () => products) },
      productImage: {
        findMany: vi.fn(async () => products.flatMap(product => product.images)),
        count: vi.fn(async ({ where }: { where: { url: string } }) => products.flatMap(product => product.images).filter(image => image.url === where.url).length),
        create: vi.fn(async ({ data }: { data: { productId: number; url: string; visible: boolean } }) => {
          const image = { ...data, id: 200 + data.productId };
          products.find(product => product.id === data.productId)!.images.push(image);
          return image;
        }),
      },
    };
    const db = { ...tx, $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
    const count = pack.files.length - 1;
    expect(await importProductPhotos(db, pack)).toMatchObject({ dryRun: true, assignedImages: count, existingImagesSkipped: 1 });
    expect(tx.productImage.create).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    expect(await importProductPhotos(db, pack, false)).toMatchObject({ assignedImages: count, existingImagesSkipped: 1 });
    expect(products[0]!.images).toEqual([existing]);
    for (const file of pack.files.slice(1)) {
      const image = products.find(product => product.slug === file.product.slug)!.images[0]!;
      expect(await readFile(managedPath(image.url)!)).toEqual(file.buffer);
    }
    expect(await importProductPhotos(db, pack, false)).toMatchObject({ assignedImages: 0, unchangedImages: count, existingImagesSkipped: 1 });
    expect(await validateProductPhotos(db, pack)).toMatchObject({ validatedSlugImageLinks: count, wrongAssignments: 1 });
    products[0]!.name = 'Different SKU name';
    await expect(importProductPhotos(db, pack)).rejects.toThrow('Название Product не совпадает');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
