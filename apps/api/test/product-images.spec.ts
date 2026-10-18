import { StandardSchemaValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import sharp from 'sharp';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { DbService } from '../src/db/db.service.js';
import { Prisma } from '../src/db/gen/client.js';
import { FavoriteCtrl } from '../src/favorite/favorite.ctrl.js';
import { FavoriteService } from '../src/favorite/favorite.service.js';
import { IMAGE_OPTIONS } from '../src/product/image-config.js';
import { ProductImageModule } from '../src/product/image.module.js';
import { ImageRegistry } from '../src/product/image-registry.js';
import { configureProductImageHttp } from '../src/product/image-static.js';
import { ProductCtrl } from '../src/product/product.ctrl.js';
import { ProductService } from '../src/product/product.service.js';
import { productQuerySchema } from '../src/product/schema.js';
import {
  imageFixture,
  imageTree,
  imageUrl,
  type ImageFixture,
} from './fixtures/product-images.js';

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  return { ...actual, default: vi.fn(actual.default) };
});
function card(id = 1) {
  return {
    id,
    name: 'Яблоки',
    slug: 'apples-' + id,
    price: 10000,
    priceQty: 1,
    unit: 'PIECE',
    step: 1,
    min: 1,
    portionQty: 1,
    category: { name: 'Фрукты', slug: 'fruits' },
    marketPoint: null,
    images: [{ url: imageUrl(), alt: 'Исходное фото' }],
  };
}
let fixture: ImageFixture;
let app: NestExpressApplication;
let cards: ReturnType<typeof card>[];
let insideTransaction = false;
const findMany = vi.fn();
const findFirst = vi.fn();
const count = vi.fn();
const favorites = vi.fn();
const category = vi.fn();
const raw = vi.fn<(query: Prisma.Sql) => Promise<unknown[]>>();
let registry: ImageRegistry;
let products: ProductService;
const http = () => request(app.getHttpServer());
async function application(enabled = true) {
  const model = {
    product: {
      findMany,
      findFirst,
      count,
      aggregate: async () => ({ _max: { id: 100 } }),
    },
    category: { findUnique: category },
    favorite: { findMany: favorites },
    $queryRaw: raw,
  };
  const db = {
    ...model,
    async $transaction(
      queries: Promise<unknown>[] | ((tx: typeof model) => Promise<unknown>),
    ) {
      insideTransaction = true;
      try {
        return typeof queries === 'function'
          ? await queries(model)
          : await Promise.all(queries);
      } finally {
        insideTransaction = false;
      }
    },
  };
  const module = await Test.createTestingModule({
    imports: [ProductImageModule],
    controllers: [ProductCtrl, FavoriteCtrl],
    providers: [
      ProductService,
      FavoriteService,
      { provide: DbService, useValue: db },
      {
        provide: AuthService,
        useValue: {
          me: async (token?: string) =>
            token === 'fixture'
              ? {
                  id: 7,
                  phone: null,
                  name: null,
                  role: 'USER',
                  verifiedAt: null,
                }
              : null,
        },
      },
    ],
  })
    .overrideProvider(IMAGE_OPTIONS)
    .useValue({ ...fixture.options, enabled })
    .compile();
  app = module.createNestApplication<NestExpressApplication>({ logger: false });
  registry = app.get(ImageRegistry);
  products = app.get(ProductService);
  const enrich = registry.enrich.bind(registry);
  vi.spyOn(registry, 'enrich').mockImplementation(async (items) => {
    expect(insideTransaction).toBe(false);
    return enrich(items);
  });
  configureProductImageHttp(app, registry, fixture.sourceRoot);
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
  await app.init();
}
beforeEach(async () => {
  fixture = await imageFixture();
  cards = [card()];
  insideTransaction = false;
  findMany.mockReset().mockImplementation(async () => cards);
  findFirst
    .mockReset()
    .mockImplementation(async () => ({ ...cards[0], description: 'Описание' }));
  count.mockReset().mockImplementation(async () => cards.length);
  favorites
    .mockReset()
    .mockImplementation(async () => cards.map((product) => ({ product })));
  category.mockReset().mockResolvedValue({ name: 'Фрукты', slug: 'fruits' });
  raw.mockReset().mockImplementation(async (query) =>
    query.sql.includes('count(*)')
      ? [{ total: cards.length, revision: null }]
      : cards.map((product) => ({
          id: product.id,
          name: product.name,
          price: product.price,
          sort: 0,
          createdAt: new Date('2026-10-15T00:00:00Z'),
          categoryId: 1,
          categorySort: 0,
        })),
  );
  await application();
  vi.mocked(sharp).mockClear();
});
afterEach(async () => {
  await app?.close();
  await fixture.close();
});
async function readonly<T>(operation: () => Promise<T>) {
  const before = await imageTree(fixture.root);
  vi.mocked(sharp).mockClear();
  const result = await operation();
  expect(sharp).not.toHaveBeenCalled();
  expect(await imageTree(fixture.root)).toEqual(before);
  return result;
}
function metadata() {
  return {
    width: 960,
    height: 720,
    variants: {
      version: 'v1',
      webp: fixture.manifest.candidates.map(({ url, width, height }) => ({
        url,
        width,
        height,
      })),
    },
  };
}

describe('product image API without a database connection', () => {
  it('enriches products after the existing transaction and preserves pagination, price, URL and alt', async () => {
    const response = await readonly(() =>
      http().get('/api/products').expect(200),
    );
    expect(response.body).toEqual({
      items: [
        {
          ...card(),
          price: 11000,
          images: [{ ...card().images[0], ...metadata() }],
        },
      ],
      total: 1,
      page: 1,
      limit: 24,
      pages: 1,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          images: {
            where: { visible: true },
            select: { url: true, alt: true },
            orderBy: [{ sort: 'asc' }, { id: 'asc' }],
          },
        }),
      }),
    );
  });

  it('enriches detail while preserving description and active/category conditions', async () => {
    const response = await readonly(() =>
      http().get('/api/products/apples-1').expect(200),
    );
    expect(response.body).toMatchObject({
      id: 1,
      description: 'Описание',
      price: 11000,
      images: [{ url: imageUrl(), alt: 'Исходное фото', ...metadata() }],
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'apples-1', active: true, category: { active: true } },
      }),
    );
  });

  it('enriches cursor feeds after transaction, keeping totals, cursor and query semantics', async () => {
    cards = [card(1), card(2), card(3)];
    const response = await readonly(() =>
      http()
        .get('/api/products')
        .query({ feed: 'catalog', limit: 2 })
        .expect(200),
    );
    expect(response.body).toMatchObject({
      total: 3,
      limit: 2,
      page: 1,
      pages: 2,
    });
    expect(response.body.nextCursor).toEqual(expect.any(String));
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0].images).toEqual([
      { url: imageUrl(), alt: 'Исходное фото', ...metadata() },
    ]);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('enriches grouped priority search only after its transaction', async () => {
    const response = await readonly(() =>
      http()
        .get('/api/products')
        .query({ q: 'яблоко', category: 'fruits' })
        .expect(200),
    );
    expect(response.body).toMatchObject({
      currentCategory: { name: 'Фрукты', slug: 'fruits' },
      groupTotals: { current: 1, others: 1 },
      total: 2,
    });
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0].images[0]).toMatchObject(metadata());
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('enriches authorized favorites and keeps the existing AuthGuard', async () => {
    await http().get('/api/favorites').expect(401);
    expect(favorites).not.toHaveBeenCalled();
    const response = await readonly(() =>
      http()
        .get('/api/favorites')
        .set('Cookie', SID + '=fixture')
        .expect(200),
    );
    expect(response.body).toEqual({
      items: [
        {
          ...card(),
          price: 11000,
          images: [{ ...card().images[0], ...metadata() }],
        },
      ],
    });
    expect(favorites).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, product: { active: true } },
      }),
    );
  });

  it('batch-deduplicates identical photos across the catalogue without changing product or image order', async () => {
    cards = Array.from({ length: 60 }, (_, index) => ({
      ...card(index + 1),
      images: [
        { url: imageUrl(), alt: 'Первое' },
        { url: imageUrl(), alt: 'Второе' },
      ],
    }));
    const lookup = vi.spyOn(registry, 'metadata');
    const response = await readonly(() =>
      http().get('/api/products').query({ limit: 60 }).expect(200),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(response.body.items.map((item: { id: number }) => item.id)).toEqual(
      cards.map((item) => item.id),
    );
    expect(
      response.body.items[0].images.map((image: { alt: string }) => image.alt),
    ).toEqual(['Первое', 'Второе']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('preserves exact legacy JSON with the feature disabled even when READY exists', async () => {
    await app.close();
    await application(false);
    const before = await products.list(productQuerySchema.parse({}));
    const list = await readonly(() => http().get('/api/products').expect(200));
    expect(list.body).toEqual(before);
    expect(list.body.items[0].images).toEqual(card().images);
    const detail = await readonly(() =>
      http().get('/api/products/apples-1').expect(200),
    );
    expect(detail.body.images).toEqual(card().images);
    const favorite = await readonly(() =>
      http()
        .get('/api/favorites')
        .set('Cookie', SID + '=fixture')
        .expect(200),
    );
    expect(favorite.body.items[0].images).toEqual(card().images);
    await http().get(imageUrl()).expect(200);
    await http()
      .get(fixture.manifest.candidates[0]!.url)
      .expect(404)
      .expect('Cache-Control', 'no-store');
  });

  it('returns the original DTO for metadata failures instead of a catalogue 500', async () => {
    vi.spyOn(registry, 'metadata').mockRejectedValueOnce(
      new Error('private path EIO'),
    );
    const response = await readonly(() =>
      http().get('/api/products').expect(200),
    );
    expect(response.body.items[0].images).toEqual(card().images);
  });

  it('keeps service/projection consumers unchanged outside the selected HTTP routes', async () => {
    const page = await products.list(productQuerySchema.parse({}));
    expect(page.items[0]!.images).toEqual(card().images);
    const detail = await products.get('apples-1');
    expect(detail.images).toEqual(card().images);
    expect(registry.enrich).not.toHaveBeenCalled();
  });

  it('keeps not-found errors without attempting image enrichment', async () => {
    findFirst.mockResolvedValueOnce(null);
    await http().get('/api/products/missing').expect(404);
    expect(registry.enrich).not.toHaveBeenCalled();
  });
});
