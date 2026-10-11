import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/db/gen/client.js';
import type { DbService } from '../src/db/db.service.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { customerPrice } from '../src/product/pricing.js';
import { importCatalog } from '../data/catalog-import/import.js';
import {
  parseCatalog,
  productValues,
  readCatalog,
  type Catalog,
} from '../data/catalog-import/input.js';

describe('catalog draft / file validation', () => {
  it('validates all units and pack weights without leaking metadata or price previews into product fields', async () => {
    const catalog = await readCatalog();
    expect(catalog.products).toHaveLength(114);
    expect(
      catalog.products
        .filter((row) => row.unit === 'PACK')
        .map((row) => row.netWeightGrams),
    ).toEqual([70, 250, 125, 125, 125, 100]);
    const row = catalog.products.find(
      (row) => row.catalogKey === 'strawberries-250g',
    )!;
    const values = productValues(row, 1, 41);
    expect(values).toMatchObject({
      price: 60000,
      unit: 'PACK',
      priceQty: 1,
      min: 1,
      step: 1,
      portionQty: 1,
      active: false,
    });
    expect(customerPrice(values.price)).toBe(66000);
    expect(values).not.toHaveProperty('netWeightGrams');
    expect(values).not.toHaveProperty('customerPricePreviewKopecks');
    expect(row.previousSlug).toBe('moscow-market-strawberries-250g');
    const preview = structuredClone(catalog);
    Object.assign(preview.products[0], { customerPricePreviewKopecks: 999999 });
    expect(parseCatalog(preview).products[0].sellerPrice).toBe(
      catalog.products[0].sellerPrice,
    );
  });

  it('rejects duplicates, fractional/zero prices, incorrect quantity steps and pack quantities before DB access', async () => {
    const catalog = await readCatalog();
    const duplicate = structuredClone(catalog);
    duplicate.products[1].slug = duplicate.products[0].slug;
    expect(() => parseCatalog(duplicate)).toThrow('Повторяющийся slug');
    for (const price of [0, 100.5]) {
      const invalid = structuredClone(catalog);
      invalid.products[0].sellerPrice = price;
      expect(() => parseCatalog(invalid)).toThrow();
    }
    const quantity = structuredClone(catalog);
    quantity.products[0].min = 501;
    expect(() => parseCatalog(quantity)).toThrow(
      'Минимальный заказ должен быть кратен',
    );
    const pack = structuredClone(catalog);
    pack.products.find((row) => row.unit === 'PACK')!.priceQty = 70;
    expect(() => parseCatalog(pack)).toThrow('PACK продаётся упаковками');
    const weight = structuredClone(catalog);
    weight.products.find((row) => row.unit === 'PACK')!.netWeightGrams = 100;
    expect(() => parseCatalog(weight)).toThrow('фасовка PACK');
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  'catalog draft / isolated local PostgreSQL',
  () => {
    const schema = `catalog_import_test_${randomUUID().replaceAll('-', '')}`;
    let connection: pg.Client,
      db: PrismaClient,
      catalog: Catalog,
      pointId: number;
    let created = false;

    beforeAll(async () => {
      const connectionString = process.env.DATABASE_URL!;
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(connectionString).hostname,
        )
      )
        throw new Error('Local database required');
      catalog = await readCatalog();
      connection = new pg.Client({ connectionString });
      await connection.connect();
      if (!/^catalog_import_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema');
      await connection.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await connection.query(`SET search_path TO "${schema}"`);
      const root = resolve('prisma/migrations');
      for (const entry of (await readdir(root, { withFileTypes: true }))
        .filter((row) => row.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(
          await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
        );
      db = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString, options: `-c search_path=${schema}` },
          { schema },
        ),
      });
      pointId = (
        await db.marketPoint.findUniqueOrThrow({
          where: { slug: catalog.marketPointSlug },
        })
      ).id;
    }, 60_000);

    beforeEach(async () => {
      await db.product.deleteMany();
      await db.category.deleteMany();
      for (const category of catalog.categories.filter(
        (row) => row.slug !== 'berries',
      ))
        await db.category.create({ data: category });
    });

    afterAll(async () => {
      await db?.$disconnect();
      if (created && /^catalog_import_test_[a-f0-9]{32}$/.test(schema))
        await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
      await connection?.end();
    });

    async function product(
      key: string,
      changes: Partial<Prisma.ProductUncheckedCreateInput> = {},
    ) {
      const row = catalog.products.find((row) => row.catalogKey === key);
      if (!row) throw new Error(`Unknown fixture ${key}`);
      const category = await db.category.findUniqueOrThrow({
        where: { slug: row.categorySlug },
      });
      return db.product.create({
        data: { ...productValues(row, category.id, pointId), ...changes },
      });
    }

    it('dry-run resolves every row and plans berries while leaving products, categories and images untouched', async () => {
      await product('tomatoes-pink', {
        slug: 'old-pink',
        name: 'Томаты розовые',
        price: 54321,
        description: null,
        marketPointId: null,
      });
      const before = await db.product.findMany({ include: { images: true } });
      const categories = await db.category.findMany();
      const result = await importCatalog(db, catalog);
      expect(result).toMatchObject({
        ok: true,
        dryRun: true,
        summary: { total: 114, created: 113, matched: 1, skipped: 0 },
      });
      expect(
        result.products.find((row) => row.catalogKey === 'tomatoes-pink'),
      ).toMatchObject({
        slug: 'old-pink',
        sellerPrice: 54321,
        matchedBy: 'name-unit-pack',
        photoFileName: 'old-pink.webp',
      });
      expect(
        result.categories.find((row) => row.slug === 'berries'),
      ).toMatchObject({ action: 'create', id: null });
      expect(await db.product.findMany({ include: { images: true } })).toEqual(
        before,
      );
      expect(await db.category.findMany()).toEqual(categories);
    });

    it('matches current/previous/name slugs, saves descriptions and packs, and preserves actual admin edits on repeated import', async () => {
      const pink = await product('tomatoes-pink', {
        slug: 'old-pink',
        name: 'Томаты розовые',
        price: 54321,
        active: true,
        description: null,
        marketPointId: null,
        sourceUrl: null,
        sourceCheckedAt: null,
      });
      const legacy = await product('potatoes-sineglazka', {
        slug: 'moscow-market-potatoes-sineglazka',
        price: 29900,
        priceStatus: 'AUDITED',
        description: 'Ручное описание',
        marketPointId: null,
      });
      const watercress = await product('watercress', {
        price: 77777,
        priceStatus: 'SOURCE',
        active: true,
      });
      const image = await db.productImage.create({
        data: {
          productId: pink.id,
          url: '/uploads/existing.webp',
          alt: 'Existing',
          visible: false,
        },
      });
      const result = await importCatalog(db, catalog, false);
      expect(result).toMatchObject({
        ok: true,
        summary: { created: 111, matched: 3, skipped: 0 },
      });
      expect(
        result.products.find((row) => row.catalogKey === 'potatoes-sineglazka')
          ?.matchedBy,
      ).toBe('previousSlug');
      expect(
        result.products.find((row) => row.catalogKey === 'watercress')
          ?.matchedBy,
      ).toBe('slug');
      expect(
        await db.product.findUniqueOrThrow({
          where: { id: pink.id },
          include: { images: true },
        }),
      ).toMatchObject({
        price: 54321,
        active: true,
        slug: 'old-pink',
        name: 'Томаты розовые',
        description: catalog.products.find(
          (row) => row.catalogKey === 'tomatoes-pink',
        )!.description,
        images: [image],
      });
      expect(
        await db.product.findUniqueOrThrow({ where: { id: legacy.id } }),
      ).toMatchObject({
        price: 29900,
        priceStatus: 'AUDITED',
        description: 'Ручное описание',
      });
      for (const row of catalog.products.filter(
        (row) =>
          !['tomatoes-pink', 'potatoes-sineglazka', 'watercress'].includes(
            row.catalogKey,
          ),
      ))
        expect(
          await db.product.findUniqueOrThrow({ where: { slug: row.slug } }),
        ).toMatchObject({
          name: row.name,
          description: row.description,
          price: row.sellerPrice,
          priceStatus: 'ESTIMATED',
          active: false,
          unit: row.unit,
          priceQty: row.priceQty,
          min: row.min,
          step: row.step,
          portionQty: row.portionQty,
        });
      const database = db as unknown as DbService;
      const admin = new AdminProductsService(
        database,
        new ImagesService(database),
      );
      await admin.update(pink.id, {
        price: 19999,
        active: false,
        description: 'Из админки',
        priceStatus: 'ESTIMATED',
      });
      await admin.update(legacy.id, { price: 88888, priceStatus: 'AUDITED' });
      await admin.update(watercress.id, {
        price: 12345,
        priceStatus: 'SOURCE',
      });
      const before = await db.product.findMany({
        include: { images: true },
        orderBy: { id: 'asc' },
      });
      const replay = await importCatalog(db, catalog, false);
      expect(replay.summary).toEqual({
        total: 114,
        created: 0,
        matched: 114,
        updated: 0,
        unchanged: 114,
        skipped: 0,
      });
      expect(
        await db.product.findMany({
          include: { images: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      expect(await db.product.count()).toBe(114);
      expect(await db.category.count({ where: { name: 'Ягоды' } })).toBe(1);
    }, 30_000);

    it('reuses berries by name and keeps products of another seller and distinct varieties separate', async () => {
      const berries = await db.category.create({
        data: { slug: 'yagody', name: 'Ягоды' },
      });
      const other = await db.marketPoint.findFirstOrThrow({
        where: { id: { not: pointId } },
      });
      const elsewhere = await product('tomatoes-pink', {
        slug: 'other-seller-pink',
        marketPointId: other.id,
      });
      const generic = await product('avocado-green', {
        slug: 'generic-avocado',
        name: 'Авокадо',
      });
      const result = await importCatalog(db, catalog, false);
      expect(result.summary.created).toBe(114);
      expect(
        result.categories.find((row) => row.slug === 'berries'),
      ).toMatchObject({
        action: 'keep',
        id: berries.id,
        existingSlug: 'yagody',
      });
      expect(await db.category.count({ where: { name: 'Ягоды' } })).toBe(1);
      expect(
        await db.product.findUniqueOrThrow({ where: { id: elsewhere.id } }),
      ).toEqual(elsewhere);
      expect(
        await db.product.findUniqueOrThrow({ where: { id: generic.id } }),
      ).toEqual(generic);
      expect(await db.product.count()).toBe(116);
    });

    it('does not create a missing point or partially create berries/products', async () => {
      await db.marketPoint.update({
        where: { id: pointId },
        data: { slug: 'temporarily-missing' },
      });
      try {
        const result = await importCatalog(db, catalog);
        expect(result.ok).toBe(false);
        expect(result.summary.skipped).toBe(114);
        await expect(importCatalog(db, catalog, false)).rejects.toThrow(
          'Не найдена торговая точка',
        );
        expect(await db.product.count()).toBe(0);
        expect(await db.category.count()).toBe(3);
        expect(
          await db.marketPoint.count({
            where: { slug: catalog.marketPointSlug },
          }),
        ).toBe(0);
      } finally {
        await db.marketPoint.update({
          where: { id: pointId },
          data: { slug: catalog.marketPointSlug },
        });
      }
    });

    it('reports ambiguous matches and rejects the entire write before mutations', async () => {
      await product('tomatoes-pink', {
        slug: 'first-pink',
        name: 'Томаты розовые',
      });
      await product('tomatoes-pink', {
        slug: 'second-pink',
        name: 'Томаты розовые',
      });
      const result = await importCatalog(db, catalog);
      expect(result).toMatchObject({ ok: false, summary: { skipped: 1 } });
      expect(
        result.products.find((row) => row.catalogKey === 'tomatoes-pink')
          ?.candidates,
      ).toHaveLength(2);
      await expect(importCatalog(db, catalog, false)).rejects.toThrow(
        'Несколько существующих товаров',
      );
      expect(await db.product.count()).toBe(2);
      expect(await db.category.count()).toBe(3);
    });

    it.each([
      { unit: 'BUNCH' as const, name: 'Кресс-салат свежий, упаковка 70 г' },
      { unit: 'PACK' as const, name: 'Кресс-салат свежий, упаковка 100 г' },
    ])(
      'rejects a slug collision with incompatible unit/pack: $unit / $name',
      async (changes) => {
        const current = await product('watercress', changes);
        const result = await importCatalog(db, catalog);
        expect(result).toMatchObject({ ok: false, summary: { skipped: 1 } });
        await expect(importCatalog(db, catalog, false)).rejects.toThrow(
          'Slug занят',
        );
        expect(
          await db.product.findUniqueOrThrow({ where: { id: current.id } }),
        ).toEqual(current);
        expect(await db.product.count()).toBe(1);
      },
    );

    it('rolls back products and a new berries category if a late write fails', async () => {
      await connection.query(`CREATE FUNCTION reject_catalog_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.slug = 'vegetables-fruits-east-physalis-100g' THEN RAISE EXCEPTION 'fixture rejects last product'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_catalog_row BEFORE INSERT ON "Product" FOR EACH ROW EXECUTE FUNCTION reject_catalog_row();`);
      try {
        await expect(importCatalog(db, catalog, false)).rejects.toThrow();
        expect(await db.product.count()).toBe(0);
        expect(await db.category.count()).toBe(3);
      } finally {
        await connection.query(
          'DROP TRIGGER reject_catalog_row ON "Product"; DROP FUNCTION reject_catalog_row()',
        );
      }
    });

    it('concurrent imports cannot create duplicate catalog rows', async () => {
      const results = await Promise.allSettled([
        importCatalog(db, catalog, false),
        importCatalog(db, catalog, false),
      ]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      expect(await db.product.count()).toBe(114);
      expect(await db.category.count({ where: { name: 'Ягоды' } })).toBe(1);
      expect((await importCatalog(db, catalog)).summary.created).toBe(0);
    }, 30_000);
  },
);
