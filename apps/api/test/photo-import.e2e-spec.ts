import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import type { DbService } from '../src/db/db.service.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import type { PhotoPack } from '../src/product/photo-pack.js';
import { ProductCtrl } from '../src/product/product.ctrl.js';
import { ProductService } from '../src/product/product.service.js';
import { CartCtrl } from '../src/cart/cart.ctrl.js';
import { CartService } from '../src/cart/cart.service.js';
import { FavoriteCtrl } from '../src/favorite/favorite.ctrl.js';
import { FavoriteService } from '../src/favorite/favorite.service.js';
import { OrderService } from '../src/order/order.service.js';
import { AuthService, SID } from '../src/auth/auth.service.js';

describe.skipIf(!process.env.DATABASE_URL)('product photo import / isolated local PostgreSQL', () => {
  const schema = `photo_import_test_${randomUUID().replaceAll('-', '')}`;
  let root: string, db: PrismaClient, connection: pg.Client, created = false;
  let app: INestApplication<Server>, pack: PhotoPack, userId: number;
  let photos: typeof import('../src/product/photo-import.js');
  let photoFiles: typeof import('../src/product/photo-pack.js');
  const cookie = () => `${SID}=photo-user`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error('Local database required');
    root = await mkdtemp(join(tmpdir(), 'korzina-photo-import-test-'));
    vi.stubEnv('UPLOAD_DIR', root);
    vi.resetModules();
    photos = await import('../src/product/photo-import.js');
    photoFiles = await import('../src/product/photo-pack.js');
    pack = await photoFiles.readPhotoPack(resolve('data/product-photos/2026-10-07'));
    expect(pack.audit.clean).toBe(true);
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^photo_import_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    const category = await db.category.create({ data: { name: 'Photo fixtures', slug: 'photo-fixtures' } });
    for (const source of pack.manifest.products) {
      const point = await db.marketPoint.upsert({ where: { slug: source.marketPointSlug }, update: {},
        create: { slug: source.marketPointSlug, name: source.marketPointName, kind: 'STALL',
          floor: 2, mapX: 20, mapY: 20, isPublished: true } });
      const weighted = source.slug === 'romanovskoe-osetrovoe-hozyaystvo-chilled-sturgeon';
      await db.product.create({ data: { slug: source.slug, name: source.name, categoryId: category.id,
        marketPointId: point.id, price: weighted ? 190000 : 10000, unit: weighted ? 'GRAM' : 'PIECE',
        priceQty: weighted ? 1000 : 1, min: weighted ? 100 : 1, step: weighted ? 100 : 1,
        portionQty: weighted ? 500 : 1 } });
    }
    userId = (await db.user.create({ data: { role: 'USER' } })).id;
    const database = db as unknown as DbService;
    const orders = new OrderService(database, { notifyNewOrder: vi.fn() } as unknown as TelegramService);
    const module = await Test.createTestingModule({
      controllers: [ProductCtrl, CartCtrl, FavoriteCtrl], providers: [
        { provide: ProductService, useValue: new ProductService(database) },
        { provide: CartService, useValue: new CartService(database, orders) },
        { provide: FavoriteService, useValue: new FavoriteService(database) },
        { provide: AuthService, useValue: { me: async () => ({ id: userId, role: 'USER' }) } },
      ],
    }).compile();
    const express = module.createNestApplication<NestExpressApplication>({ logger: false });
    express.useStaticAssets(root, { prefix: '/uploads/products/' });
    express.use(cookieParser()); express.setGlobalPrefix('api');
    express.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await express.init(); app = express;
  }, 60000);
  beforeEach(async () => {
    await db.productImage.deleteMany();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('korzina-photo-import-test-')) throw new Error('Unsafe image test root');
    for (const file of await readdir(root)) await rm(join(root, file));
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^photo_import_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end();
    if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('korzina-photo-import-test-')) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }, 30000);

  it('dry-run/apply/repeat preserves all Product and MarketPoint data and validates 146 exact byte-identical links', async () => {
    const before = await db.product.findMany({ orderBy: { id: 'asc' } });
    const points = await db.marketPoint.findMany({ orderBy: { id: 'asc' } });
    expect(await photos.importProductPhotos(db, pack)).toMatchObject({ assignedImages: 146, created: 146, existingImagesSkipped: 0 });
    expect(await db.productImage.count()).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(await photos.importProductPhotos(db, pack, false)).toMatchObject({ matchedProducts: 146, assignedImages: 146, failedImages: 0 });
    expect(await photos.importProductPhotos(db, pack)).toMatchObject({ assignedImages: 0, created: 0, updated: 0, unchangedImages: 146 });
    expect(await photos.importProductPhotos(db, pack, false)).toMatchObject({ assignedImages: 0, unchangedImages: 146 });
    expect(await db.productImage.count()).toBe(146);
    expect(await readdir(root)).toHaveLength(146);
    expect(await photos.validateProductPhotos(db, pack)).toMatchObject({ validatedSlugImageLinks: 146, wrongAssignments: 0 });
    expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db.marketPoint.findMany({ orderBy: { id: 'asc' } })).toEqual(points);
  });

  it('returns the correct images through detail, catalogue, search, categories, MarketPoint, favorites and cart; URLs return 200', async () => {
    await photos.importProductPhotos(db, pack, false);
    for (const file of pack.files) {
      const detail = (await http().get('/api/products/' + file.product.slug).expect(200)).body;
      const url = photoFiles.placeholderUrl(file.product, pack.manifest.batch);
      expect(detail.images[0]).toMatchObject({ url });
      expect(detail.marketPoint.slug).toBe(file.product.marketPointSlug);
      const image = await http().get(url).expect(200).expect('Content-Type', /image\/webp/);
      expect(photoFiles.photoHash(image.body as Buffer)).toBe(file.product.sha256);
    }
    const first = pack.files.find(file => file.product.slug === 'romanovskoe-osetrovoe-hozyaystvo-chilled-sturgeon')!;
    const url = photoFiles.placeholderUrl(first.product, pack.manifest.batch);
    const product = await db.product.findUniqueOrThrow({ where: { slug: first.product.slug }, include: { category: true } });
    for (const query of [{}, { q: 'STANDARD' }, { category: product.category.slug }, { marketPoint: first.product.marketPointSlug }]) {
      const result = await http().get('/api/products').query(query).expect(200);
      expect(result.body.items.length).toBeGreaterThan(0);
      expect(result.body.items.every((row: { images: { url: string }[] }) => row.images.length === 1)).toBe(true);
    }
    await http().post('/api/favorites/' + product.id).set('Cookie', cookie()).expect(201);
    expect((await http().get('/api/favorites').set('Cookie', cookie()).expect(200)).body.items[0].images[0].url).toBe(url);
    const cart = (await http().get('/api/cart').set('Cookie', cookie()).expect(200)).body;
    const added = await http().post('/api/cart/change').set('Cookie', cookie())
      .send({ revision: cart.revision, kind: 'add', productId: product.id, qty: 500 }).expect(201);
    expect(added.body.items[0].product.images[0].url).toBe(url);
    expect(added.body.products[0].images[0].url).toBe(url);
    expect(added.body.subtotal).toBe(104500);
  });

  it('never replaces an existing real or hidden photo', async () => {
    const first = await db.product.findUniqueOrThrow({ where: { slug: pack.files[0]!.product.slug } });
    const image = await db.productImage.create({ data: { productId: first.id, url: `/uploads/products/${randomUUID()}.webp`, visible: false, alt: 'Real product photo' } });
    expect(await photos.importProductPhotos(db, pack, false)).toMatchObject({ assignedImages: 145, existingImagesSkipped: 1 });
    expect(await db.productImage.findMany({ where: { productId: first.id } })).toEqual([image]);
    expect(await photos.importProductPhotos(db, pack)).toMatchObject({ assignedImages: 0, existingImagesSkipped: 1, unchangedImages: 145 });
  });

  it('rejects missing products, wrong MarketPoint and foreign image links before file or DB writes', async () => {
    const first = pack.files[0]!;
    const product = await db.product.findUniqueOrThrow({ where: { slug: first.product.slug } });
    await db.product.update({ where: { id: product.id }, data: { slug: 'temporary-missing-photo-product' } });
    await expect(photos.importProductPhotos(db, pack, false)).rejects.toThrow('Product не найден');
    await db.product.update({ where: { id: product.id }, data: { slug: first.product.slug, marketPointId: null } });
    await expect(photos.importProductPhotos(db, pack, false)).rejects.toThrow('Неверный MarketPoint');
    await db.product.update({ where: { id: product.id }, data: { marketPointId: product.marketPointId } });
    const other = await db.product.findFirstOrThrow({ where: { id: { not: product.id } } });
    await db.productImage.create({ data: { productId: other.id, url: photoFiles.placeholderUrl(first.product, pack.manifest.batch) } });
    await expect(photos.importProductPhotos(db, pack, false)).rejects.toThrow('с другим Product');
    expect(await readdir(root)).toEqual([]);
    expect(await db.productImage.count()).toBe(1);
  });

  it('serializes simultaneous imports without duplicate files or records', async () => {
    const results = await Promise.all([photos.importProductPhotos(db, pack, false), photos.importProductPhotos(db, pack, false)]);
    expect(results.map(row => row.assignedImages).sort((a, b) => a - b)).toEqual([0, 146]);
    expect(await db.productImage.count()).toBe(146);
    expect(await readdir(root)).toHaveLength(146);
  });

  it('does not overwrite a conflicting file and detects missing runtime files', async () => {
    const file = pack.files[0]!;
    const name = photoFiles.placeholderUrl(file.product, pack.manifest.batch).split('/').at(-1)!;
    await writeFile(join(root, name), 'unrelated existing bytes');
    await expect(photos.importProductPhotos(db, pack, false)).rejects.toThrow('отличается от исходного');
    expect(await readFile(join(root, name), 'utf8')).toBe('unrelated existing bytes');
    expect(await db.productImage.count()).toBe(0);
    await rm(join(root, name));
    await photos.importProductPhotos(db, pack, false);
    await rm(join(root, name));
    expect(await photos.validateProductPhotos(db, pack)).toMatchObject({ validatedSlugImageLinks: 145, wrongAssignments: 1 });
    await expect(photos.importProductPhotos(db, pack)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
