import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { Prisma, type PrismaClient } from '../db/gen/client.js';
import { managedPath, uploadRoot } from '../admin/images.service.js';
import { photoHash, placeholderUrl, type PhotoPack } from './photo-pack.js';

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
}

export async function importProductPhotos(db: PrismaClient, pack: PhotoPack, dryRun = true) {
  if (!pack.audit.clean) throw new Error(`Фотопак не прошёл аудит: ${JSON.stringify(pack.audit)}`);
  const createdFiles: { path: string; url: string }[] = [];
  try {
    return await db.$transaction(async tx => {
      if (dryRun) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      else await tx.$queryRaw`SELECT id FROM "Product" WHERE slug IN (${Prisma.join(pack.manifest.products.map(row => row.slug))}) ORDER BY id FOR UPDATE`;
      const products = await tx.product.findMany({
        where: { slug: { in: pack.manifest.products.map(row => row.slug) } },
        select: { id: true, slug: true, marketPoint: { select: { slug: true } },
          images: { select: { id: true, url: true }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] } },
      });
      const plannedUrls = pack.files.map(file => placeholderUrl(file.product, pack.manifest.batch));
      const linked = await tx.productImage.findMany({ where: { url: { in: plannedUrls } }, select: { url: true, productId: true } });
      const plan: { productId: number; slug: string; sourceFile: string; url: string;
        action: 'CREATE' | 'UNCHANGED' | 'SKIP_EXISTING'; buffer: Buffer; alt: string }[] = [];
      for (const file of pack.files) {
        const product = products.find(row => row.slug === file.product.slug);
        if (!product) throw new Error(`Product не найден: ${file.product.slug}. Импорт не создаёт товары.`);
        if (product.marketPoint?.slug !== file.product.marketPointSlug)
          throw new Error(`Неверный MarketPoint у Product ${product.slug}`);
        const url = placeholderUrl(file.product, pack.manifest.batch);
        const path = managedPath(url)!;
        if (linked.some(image => image.url === url && image.productId !== product.id))
          throw new Error(`Изображение ${url} связано с другим Product`);
        const own = product.images.filter(image => image.url === url);
        if (own.length > 1) throw new Error(`Дубли ProductImage: ${product.slug}`);
        const action = own.length ? 'UNCHANGED' : product.images.length ? 'SKIP_EXISTING' : 'CREATE';
        if (action !== 'SKIP_EXISTING') {
          try {
            if (photoHash(await readFile(path)) !== file.product.sha256)
              throw new Error(`Файл назначения отличается от исходного: ${product.slug}`);
          } catch (error) {
            if (errorCode(error) !== 'ENOENT' || action === 'UNCHANGED') throw error;
          }
        }
        plan.push({ productId: product.id, slug: product.slug, sourceFile: file.sourceFile, url, action,
          buffer: file.buffer, alt: `${file.product.name} — иллюстрация товара` });
      }
      if (!dryRun && plan.some(row => row.action === 'CREATE')) {
        await mkdir(uploadRoot, { recursive: true });
        for (const row of plan) {
          if (row.action !== 'CREATE') continue;
          const path = managedPath(row.url)!;
          try {
            await writeFile(path, row.buffer, { flag: 'wx' });
            createdFiles.push({ path, url: row.url });
          } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            if (!row.buffer.equals(await readFile(path))) throw new Error(`Файл назначения уже занят: ${row.slug}`);
          }
          await tx.productImage.create({ data: { productId: row.productId, url: row.url, alt: row.alt, sort: 0, visible: true } });
        }
      }
      const assignedImages = plan.filter(row => row.action === 'CREATE').length;
      return { dryRun, matchedProducts: products.length, assignedImages, created: assignedImages, updated: 0,
        existingImagesSkipped: plan.filter(row => row.action === 'SKIP_EXISTING').length,
        unchangedImages: plan.filter(row => row.action === 'UNCHANGED').length, failedImages: 0,
        images: plan.map(({ buffer: _buffer, ...row }) => row) };
    }, { timeout: 60000 });
  } catch (error) {
    // Never remove a file if the commit outcome is uncertain or another record references it.
    for (const file of createdFiles) {
      try {
        if (!await db.productImage.count({ where: { url: file.url } })) await unlink(file.path);
      } catch { /* Keep recoverable files when the database or filesystem is unavailable. */ }
    }
    throw error;
  }
}

export async function validateProductPhotos(db: PrismaClient, pack: PhotoPack) {
  if (!pack.audit.clean) throw new Error('Фотопак не прошёл аудит');
  const products = await db.product.findMany({ where: { slug: { in: pack.manifest.products.map(row => row.slug) } },
    select: { id: true, slug: true, marketPoint: { select: { slug: true } },
      images: { select: { id: true, url: true, visible: true } } } });
  const links = [];
  for (const file of pack.files) {
    const product = products.find(row => row.slug === file.product.slug);
    const url = placeholderUrl(file.product, pack.manifest.batch);
    const image = product?.images.find(row => row.url === url && row.visible);
    let identicalBytes = false;
    try { identicalBytes = photoHash(await readFile(managedPath(url)!)) === file.product.sha256; } catch { /* Report missing files. */ }
    links.push({ sourceFile: file.sourceFile, productSlug: product?.slug ?? null, productId: product?.id ?? null,
      imageId: image?.id ?? null, url, sha256: file.product.sha256,
      valid: Boolean(image && identicalBytes && product?.marketPoint?.slug === file.product.marketPointSlug) });
  }
  return { validatedSlugImageLinks: links.filter(row => row.valid).length,
    wrongAssignments: links.filter(row => !row.valid).length, links };
}
