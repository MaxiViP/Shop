import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import {
  imageFixture,
  imageId,
  imageTree,
  imageUrl,
  type ImageFixture,
} from '../../test/fixtures/product-images.js';
import { ImageRegistry } from './image-registry.js';
import { imageVariantUrl } from './image-manifest.js';
import { configureProductImageHttp } from './image-static.js';

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  return { ...actual, default: vi.fn(actual.default) };
});
let fixture: ImageFixture;
let app: NestExpressApplication;
let registry: ImageRegistry;
const http = () => request(app.getHttpServer());
const candidate = () => fixture.manifest.candidates[0]!;
beforeEach(async () => {
  fixture = await imageFixture();
  registry = new ImageRegistry(fixture.options);
  await application();
});
afterEach(async () => {
  await app?.close();
  await fixture.close();
});
async function application() {
  const module = await Test.createTestingModule({}).compile();
  app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureProductImageHttp(app, registry, fixture.sourceRoot);
  app.setGlobalPrefix('api');
  await app.init();
  vi.mocked(sharp).mockClear();
}
async function readonly<T>(operation: () => Promise<T>) {
  const before = await imageTree(fixture.root);
  vi.mocked(sharp).mockClear();
  const result = await operation();
  expect(sharp).not.toHaveBeenCalled();
  expect(await imageTree(fixture.root)).toEqual(before);
  return result;
}

describe('read-only variant HTTP namespace', () => {
  it('serves verified WebP before generic static, with strong immutable caching', async () => {
    const response = await readonly(() =>
      http().get(candidate().url).expect(200),
    );
    expect(response.headers['content-type']).toMatch(/^image\/webp/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(response.headers.etag).toBe('"' + candidate().sha256 + '"');
    expect(response.headers['content-length']).toBe(String(candidate().bytes));
    expect(response.body).toEqual(
      await readFile(fixture.path(candidate().url)),
    );
  });

  it('HEAD has the same entity headers and no response body', async () => {
    const get = await http().get(candidate().url).expect(200);
    const head = await readonly(() => http().head(candidate().url).expect(200));
    for (const name of [
      'content-type',
      'content-length',
      'etag',
      'last-modified',
      'cache-control',
      'x-content-type-options',
    ])
      expect(head.headers[name]).toBe(get.headers[name]);
    expect(head.text).toBeUndefined();
  });

  it('supports strong/weak If-None-Match, wildcard and conditional HEAD', async () => {
    for (const method of ['get', 'head'] as const)
      for (const etag of [
        '"' + candidate().sha256 + '"',
        'W/"' + candidate().sha256 + '"',
        '*',
      ]) {
        const response = await readonly(() =>
          http()
            [method](candidate().url)
            .set('If-None-Match', etag)
            .expect(304),
        );
        expect(response.headers['cache-control']).toContain('immutable');
        expect(response.text ?? '').toBe('');
      }
  });

  it('honors If-Modified-Since and gives If-None-Match precedence', async () => {
    const entity = await http().get(candidate().url).expect(200);
    await readonly(() =>
      http()
        .get(candidate().url)
        .set('If-Modified-Since', entity.headers['last-modified'] as string)
        .expect(304),
    );
    await readonly(() =>
      http()
        .get(candidate().url)
        .set('If-None-Match', '"different"')
        .set(
          'If-Modified-Since',
          new Date(Date.now() + 86_400_000).toUTCString(),
        )
        .expect(200),
    );
  });

  it('redirects to original without immutable/ETag after an advertised file disappears', async () => {
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    const url = candidate().url;
    const etag = candidate().sha256;
    await unlink(fixture.path(url));
    for (const method of ['get', 'head'] as const) {
      const response = await readonly(() =>
        http()
          [method](url)
          .set('If-None-Match', '"' + etag + '"')
          .expect(307),
      );
      expect(response.headers.location).toBe(imageUrl());
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers['last-modified']).toBeUndefined();
    }
    const original = await readonly(() => http().get(imageUrl()).expect(200));
    expect(original.body).toEqual(fixture.source);
    expect(original.headers['cache-control']).not.toContain('immutable');
  });

  it('falls back for changed originals, corrupt bytes and unlisted checksum URLs', async () => {
    const unlisted = imageVariantUrl(
      imageId(),
      fixture.manifest.source.sha256,
      192,
      'e'.repeat(64),
    );
    await readonly(() =>
      http().get(unlisted).expect(307).expect('Location', imageUrl()),
    );
    await writeFile(
      fixture.path(candidate().url),
      Buffer.alloc(candidate().bytes, 32),
    );
    const corrupt = await readonly(() =>
      http().get(candidate().url).expect(307),
    );
    expect(corrupt.headers['cache-control']).toBe('no-store');
    await writeFile(fixture.original, Buffer.alloc(fixture.source.length, 32));
    await readonly(() =>
      http()
        .get(candidate().url)
        .expect(307)
        .expect('Cache-Control', 'no-store'),
    );
  });

  it('serves repair URLs and never reuses corrupt immutable canonical bytes', async () => {
    const old = candidate().url;
    await writeFile(fixture.path(old), 'corrupt canonical');
    fixture.manifest = (await fixture.storage.save(imageUrl())).manifest;
    expect(candidate().url).not.toBe(old);
    await readonly(() =>
      http()
        .get(candidate().url)
        .expect(200)
        .expect('Cache-Control', 'public, max-age=31536000, immutable'),
    );
    await readonly(() =>
      http().get(old).expect(307).expect('Cache-Control', 'no-store'),
    );
  });

  it('returns no-store 404 when neither READY nor a safe original can be used', async () => {
    await unlink(fixture.original);
    await readonly(() =>
      http()
        .get(candidate().url)
        .expect(404)
        .expect('Cache-Control', 'no-store'),
    );
  });

  it.each([
    '/uploads/products/variants/',
    '/uploads/products/variants/v2/anything.webp',
    '/uploads/products/variants/%2e%2e%2fstate/ready.json',
    '/uploads/products/variants/v1/secret.json',
    '/uploads/products/variants/work/manifest.json',
    '/uploads/products/variants/runs/checkpoint.json',
    '/uploads/products/variants/v1/file.webp:stream',
  ])(
    'rejects malformed/private paths %s instead of falling through',
    async (url) => {
      const response = await readonly(() => http().get(url).expect(404));
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.text).not.toContain('never serve');
    },
  );

  it.each(['encoded', 'case', 'query', 'slash'] as const)(
    'rejects %s aliases of an existing file',
    async (kind) => {
      const url =
        kind === 'encoded'
          ? candidate().url.replace('/variants/', '/%76ariants/')
          : kind === 'case'
            ? candidate().url.replace('/variants/', '/VARIANTS/')
            : kind === 'query'
              ? candidate().url + '?download=1'
              : candidate().url.replace('/v1/', '%2fv1/');
      await readonly(() =>
        http().get(url).expect(404).expect('Cache-Control', 'no-store'),
      );
    },
  );

  it.each(['variants.', 'variants%20', 'variants...', 'variant%C5%BF'])(
    'rejects the noncanonical Windows namespace alias %s before legacy static',
    async (alias) => {
      await readonly(() =>
        http()
          .get(candidate().url.replace('/variants/', '/' + alias + '/'))
          .expect(404)
          .expect('Cache-Control', 'no-store'),
      );
    },
  );

  it('supports only read methods and leaves originals/hero/legacy static unchanged', async () => {
    await readonly(() =>
      http().post(candidate().url).expect(405).expect('Allow', 'GET, HEAD'),
    );
    await mkdir(join(fixture.sourceRoot, 'hero'));
    await writeFile(
      join(fixture.sourceRoot, 'hero', 'sample.webp'),
      fixture.source,
    );
    await writeFile(
      join(fixture.sourceRoot, 'legacy-token.webp'),
      fixture.source,
    );
    for (const path of [
      imageUrl(),
      '/uploads/products/hero/sample.webp',
      '/uploads/products/legacy-token.webp',
    ]) {
      const response = await readonly(() => http().get(path).expect(200));
      expect(response.body).toEqual(fixture.source);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).not.toContain('immutable');
    }
  });

  it('does not expose any state-root files through the public static prefix', async () => {
    for (const path of [
      '/uploads/products/ready/' + imageId() + '.json',
      '/uploads/products/state/ready/' + imageId() + '.json',
      '/uploads/products/work/manifest.json',
      '/uploads/products/runs/scope.json',
      '/uploads/products/.private.json',
    ]) {
      const response = await readonly(() => http().get(path).expect(404));
      expect(response.text).not.toContain(fixture.manifest.source.sha256);
      expect(response.text).not.toContain('never serve');
    }
  });

  it('protects canonical and encoded URLs when variants is a junction into private data', async () => {
    const outside = join(fixture.root, 'outside');
    const hashDir = join(
      outside,
      'v1',
      imageId(),
      fixture.manifest.source.sha256,
    );
    await mkdir(hashDir, { recursive: true, mode: 0o700 });
    await writeFile(join(hashDir, '192.webp'), 'private contents');
    await rename(
      join(fixture.publicRoot, 'variants'),
      join(fixture.root, 'kept-variants'),
    );
    await symlink(
      outside,
      join(fixture.publicRoot, 'variants'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const response = await readonly(() =>
      http().get(candidate().url).expect(307),
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toContain('private contents');
    await readonly(() =>
      http()
        .get(candidate().url.replace('/variants/', '/%76ariants/'))
        .expect(404),
    );
  });

  it('fails closed on unexpected reader errors, with no leaked filesystem path', async () => {
    vi.spyOn(registry, 'variant').mockRejectedValueOnce(
      new Error('C:\\private\\secrets'),
    );
    const response = await readonly(() =>
      http()
        .get(candidate().url)
        .expect(404)
        .expect('Cache-Control', 'no-store'),
    );
    expect(response.text).not.toContain('private');
  });

  it('fully disables variants while keeping existing original HTTP behavior', async () => {
    await app.close();
    registry = new ImageRegistry({ enabled: false });
    await application();
    await readonly(() =>
      http()
        .get(candidate().url)
        .expect(404)
        .expect('Cache-Control', 'no-store'),
    );
    const original = await readonly(() => http().get(imageUrl()).expect(200));
    expect(original.body).toEqual(fixture.source);
    expect(original.headers['cache-control']).not.toContain('immutable');
  });

  it.skipIf(process.platform !== 'linux').each(['source', 'variant'] as const)(
    'Linux: cannot serve private contents through a %s file symlink',
    async (kind) => {
      const path =
        kind === 'source' ? fixture.original : fixture.path(candidate().url);
      await unlink(path);
      await symlink(join(fixture.root, 'outside', 'secret.json'), path, 'file');
      const response = await readonly(() => http().get(candidate().url));
      expect(response.status).toBe(kind === 'source' ? 404 : 307);
      expect(response.text).not.toContain('never serve');
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});
