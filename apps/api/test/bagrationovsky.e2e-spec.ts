import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import type { DbService } from '../src/db/db.service.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { readResearch, type Research } from '../data/bagrationovsky/input.js';
import { planImport, readSnapshot } from '../data/bagrationovsky/queue.js';

describe.skipIf(!process.env.DATABASE_URL)(
  'Bagrationovsky staging / isolated local PostgreSQL',
  () => {
    const schema = `bagrationovsky_test_${randomUUID().replaceAll('-', '')}`;
    let connection: pg.Client,
      db: PrismaClient,
      research: Research,
      admin: AdminProductsService;
    let created = false,
      productId: number,
      pointId: number;

    beforeAll(async () => {
      const connectionString = process.env.DATABASE_URL!;
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(connectionString).hostname,
        )
      )
        throw new Error('Local database required');
      research = await readResearch();
      connection = new pg.Client({ connectionString });
      await connection.connect();
      if (!/^bagrationovsky_test_[a-f0-9]{32}$/.test(schema))
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
          where: { slug: 'chilled-meat' },
        })
      ).id;
      const category = await db.category.create({
        data: { name: 'Fixtures', slug: 'staging-fixtures' },
      });
      const database = db as unknown as DbService;
      admin = new AdminProductsService(database, new ImagesService(database));
      productId = (
        await admin.create({
          name: research.myasberry.offers[0].name,
          slug: 'manual-ravioli',
          description: 'Ручное описание',
          price: 50000,
          priceStatus: 'AUDITED',
          unit: 'GRAM',
          priceQty: 500,
          min: 100,
          step: 100,
          portionQty: 500,
          categoryId: category.id,
          marketPointId: pointId,
          active: true,
          sort: 7,
        })
      ).id;
      await db.productImage.create({
        data: {
          productId,
          url: '/uploads/existing-staging-fixture.webp',
          alt: 'Existing',
        },
      });
    }, 60_000);

    afterAll(async () => {
      await db?.$disconnect();
      if (created && /^bagrationovsky_test_[a-f0-9]{32}$/.test(schema))
        await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
      await connection?.end();
    });

    it('reads real points/products without inserting stores, source prices, products or changing existing rows', async () => {
      const products = await db.product.findMany({
        include: { images: true },
        orderBy: { id: 'asc' },
      });
      const points = await db.marketPoint.findMany({ orderBy: { id: 'asc' } });
      const categories = await db.category.findMany({ orderBy: { id: 'asc' } });
      const snapshot = await readSnapshot(db);
      const { queue, preview } = planImport(research, snapshot);
      expect(preview).toMatchObject({
        databaseMatched: true,
        liveDatabaseWrites: 0,
      });
      expect(
        preview.stores
          .find((row) => row.researchKey === 'myasberry')
          ?.candidates.some(
            (row) => row.id === pointId && row.evidence.includes('hypothesis'),
          ),
      ).toBe(true);
      expect(preview.products[0].candidates).toMatchObject([
        { id: productId, price: 50000, priceStatus: 'AUDITED' },
      ]);
      expect(queue.products[0].source.referencePrice?.amountKopecks).toBe(
        69300,
      );
      expect(queue.products[0].review.productId).toBeNull();
      expect(queue.products[0].sale.confirmedPriceKopecks).toBeNull();
      expect(
        await db.product.findMany({
          include: { images: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(products);
      expect(await db.marketPoint.findMany({ orderBy: { id: 'asc' } })).toEqual(
        points,
      );
      expect(await db.category.findMany({ orderBy: { id: 'asc' } })).toEqual(
        categories,
      );
    });

    it('keeps explicitly linked admin sale prices independent from online reference prices on repeated preparation', async () => {
      const queue = planImport(research, await readSnapshot(db)).queue;
      queue.products[0].review = {
        status: 'VERIFIED',
        marketPointId: pointId,
        productId,
        confirmedSku: 'FIXTURE-SKU',
        notes: 'Тестовое явное подтверждение',
        reviewedOn: '2026-10-11',
      };
      await admin.update(productId, {
        price: 51234,
        priceStatus: 'ESTIMATED',
        description: 'Изменено в админке',
      });
      const before = await db.product.findUniqueOrThrow({
        where: { id: productId },
        include: { images: true },
      });
      const snapshot = await readSnapshot(db);
      const repeat = planImport(research, snapshot, queue);
      expect(repeat.queue).toEqual(queue);
      expect(repeat.preview.products[0].linkedProduct).toMatchObject({
        id: productId,
        price: 51234,
        priceStatus: 'ESTIMATED',
      });
      expect(repeat.preview.products[0].referencePrice?.amountKopecks).toBe(
        69300,
      );
      expect(repeat.preview.summary).toMatchObject({
        stores: { createDrafts: 0, keepDrafts: 16 },
        products: { createDrafts: 0, keepDrafts: 168 },
      });
      expect(
        await db.product.findUniqueOrThrow({
          where: { id: productId },
          include: { images: true },
        }),
      ).toEqual(before);
      expect(await db.product.count()).toBe(1);
      // Existing backend policy still behaves as before; staging never calls it for reference quotes.
      expect(admin.pricing(50000)).toMatchObject({
        sellerPrice: 50000,
        customerPrice: 55000,
        serviceMarkupPercent: 10,
      });
    });
  },
);
