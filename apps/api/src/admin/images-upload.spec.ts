import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import type { DbService } from '../db/db.service.js';
import { ImageRegistry } from '../product/image-registry.js';
import { configureProductImageHttp } from '../product/image-static.js';
import {
  imageFixture,
  imageTree,
  type ImageFixture,
} from '../../test/fixtures/product-images.js';

// This suite must never construct a real database client.
vi.mock('../db/db.service.js', () => ({
  DbService: class {
    constructor() {
      throw new Error('Database access is forbidden in the upload fixture');
    }
  },
}));

let fixture: ImageFixture;
let app: NestExpressApplication | undefined;
let images: typeof import('./images.service.js');
let buffer: Buffer;

beforeEach(async () => {
  fixture = await imageFixture(true);
  vi.stubEnv('UPLOAD_DIR', fixture.sourceRoot);
  vi.resetModules();
  images = await import('./images.service.js');
  buffer = await sharp({
    create: { width: 12, height: 8, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await fixture.close();
  vi.unstubAllEnvs();
});

function setup(exists = true) {
  const model = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    product: {
      findUnique: vi.fn().mockResolvedValue(exists ? { id: 7 } : null),
    },
    productImage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { productId: number; url: string; sort: number };
        }) => ({ id: 1, visible: true, ...data }),
      ),
    },
  };
  const db = {
    ...model,
    $transaction: vi.fn((fn: (tx: typeof model) => Promise<unknown>) =>
      fn(model),
    ),
  };
  return {
    db,
    service: new images.ImagesService(db as unknown as DbService),
  };
}

async function protectedFiles() {
  return Promise.all([
    imageTree(fixture.publicRoot),
    imageTree(fixture.stateRoot),
    imageTree(fixture.original),
  ]);
}

it('uploads a managed WebP and serves original GET/HEAD without writing variants or state', async () => {
  const before = await protectedFiles();
  const { db, service } = setup();
  expect(images.uploadRoot).toBe(fixture.sourceRoot);
  const uploaded = await service.upload(7, {
    buffer,
    size: buffer.length,
    mimetype: 'image/png',
  });
  expect(uploaded.url).toMatch(/^\/uploads\/products\/[a-f0-9-]{36}\.webp$/);
  const content = await readFile(
    join(fixture.sourceRoot, basename(uploaded.url)),
  );
  expect(await sharp(content).metadata()).toMatchObject({
    format: 'webp',
    width: 12,
    height: 8,
  });
  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect(db.productImage.create).toHaveBeenCalledWith({
    data: { productId: 7, url: uploaded.url, sort: 0 },
  });
  const module = await Test.createTestingModule({}).compile();
  app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureProductImageHttp(
    app,
    new ImageRegistry({ enabled: false }),
    fixture.sourceRoot,
  );
  await app.init();
  const get = await request(app.getHttpServer()).get(uploaded.url).expect(200);
  expect(get.headers['content-type']).toMatch(/^image\/webp/);
  expect(get.headers['x-content-type-options']).toBe('nosniff');
  expect(get.body).toEqual(content);
  const head = await request(app.getHttpServer())
    .head(uploaded.url)
    .expect(200);
  expect(head.headers['content-length']).toBe(String(content.length));
  expect(head.text).toBeUndefined();
  expect(await protectedFiles()).toEqual(before);
});

it('removes only the new upload on transaction failure', async () => {
  const before = await protectedFiles();
  const files = await readdir(fixture.sourceRoot);
  const { db, service } = setup(false);
  await expect(
    service.upload(7, {
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
    }),
  ).rejects.toBeInstanceOf(NotFoundException);
  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect(db.productImage.create).not.toHaveBeenCalled();
  expect(await readdir(fixture.sourceRoot)).toEqual(files);
  expect(await protectedFiles()).toEqual(before);
});

it('rejects invalid uploads before a file write or transaction', async () => {
  const before = await protectedFiles();
  const files = await readdir(fixture.sourceRoot);
  const { db, service } = setup();
  const invalid = Buffer.from('synthetic invalid image');
  await expect(
    service.upload(7, {
      buffer: invalid,
      size: invalid.length,
      mimetype: 'image/png',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(await readdir(fixture.sourceRoot)).toEqual(files);
  expect(await protectedFiles()).toEqual(before);
});
