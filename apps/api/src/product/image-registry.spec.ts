import {
  lstat,
  open,
  readFile,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  imageFixture,
  imageId,
  imageTree,
  imageUrl,
  type ImageFixture,
} from '../../test/fixtures/product-images.js';
import { imageOptions } from './image-config.js';
import { ImageRegistry } from './image-registry.js';
import { imageVariantUrl } from './image-manifest.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), lstat: vi.fn(fs.lstat) };
});
vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  return { ...actual, default: vi.fn(actual.default) };
});
const native =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let fixture: ImageFixture;
let registry: ImageRegistry;
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(native.open);
  vi.mocked(lstat).mockReset().mockImplementation(native.lstat);
  fixture = await imageFixture();
  registry = new ImageRegistry(fixture.options);
  vi.mocked(open).mockClear();
  vi.mocked(lstat).mockClear();
  vi.mocked(sharp).mockClear();
});
afterEach(async () => {
  vi.mocked(open).mockImplementation(native.open);
  vi.mocked(lstat).mockImplementation(native.lstat);
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
const expected = () => ({
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
});

describe('read-only product image registry', () => {
  it('defaults off and ignores storage configuration when the flag is not exactly true', async () => {
    expect(imageOptions('/unused', {})).toEqual({ enabled: false });
    expect(
      imageOptions('/unused', { PRODUCT_IMAGE_VARIANTS_ENABLED: 'TRUE' }),
    ).toEqual({ enabled: false });
    expect(
      imageOptions('/unused', { PRODUCT_IMAGE_VARIANTS_ENABLED: '1' }),
    ).toEqual({ enabled: false });
    const disabled = new ImageRegistry(imageOptions('/unused', {}));
    expect(await disabled.metadata(imageUrl())).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('refuses missing, relative or overlapping root configuration without filesystem reads', async () => {
    for (const options of [
      { enabled: true },
      { ...fixture.options, stateRoot: 'state' },
      { ...fixture.options, stateRoot: fixture.sourceRoot },
      { ...fixture.options, stateRoot: join(fixture.publicRoot, 'private') },
      { ...fixture.options, publicRoot: join(fixture.sourceRoot, 'nested') },
    ])
      expect(await new ImageRegistry(options).metadata(imageUrl())).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('returns legacy images without a manifest and performs no writes', async () => {
    await unlink(fixture.ready);
    const product = { id: 1, images: [{ url: imageUrl(), alt: null }] };
    expect(await readonly(() => registry.enrich([product]))).toEqual([product]);
  });

  it('returns only public metadata for verified READY, preserving url/alt and ordering', async () => {
    const product = {
      id: 1,
      price: 123,
      images: [
        { url: imageUrl(), alt: 'Фото' },
        { url: '/images/legacy.webp', alt: null },
      ],
    };
    const result = await readonly(() => registry.enrich([product]));
    expect(result).toEqual([
      {
        ...product,
        images: [{ ...product.images[0], ...expected() }, product.images[1]],
      },
    ]);
    expect(product.images[0]).not.toHaveProperty('variants');
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(JSON.stringify(result)).not.toContain('"sha256"');
    expect(JSON.stringify(result)).not.toContain('"fingerprint"');
  });

  it('supports a separate public variant root with the same existing manifest format', async () => {
    await fixture.close();
    fixture = await imageFixture(true);
    registry = new ImageRegistry(fixture.options);
    expect(await readonly(() => registry.metadata(imageUrl()))).toEqual(
      expected(),
    );
  });

  it.each(['missing', 'checksum', 'oversized'] as const)(
    'does not advertise a %s candidate',
    async (kind) => {
      const missing = fixture.manifest.candidates[2]!;
      const path = fixture.path(missing.url);
      if (kind === 'missing') await unlink(path);
      if (kind === 'checksum')
        await writeFile(path, Buffer.alloc(missing.bytes, 32));
      if (kind === 'oversized')
        await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
      const result = await readonly(() => registry.metadata(imageUrl()));
      if (kind === 'oversized') expect(result).toBeNull();
      else
        expect(result?.variants.webp).toEqual(
          expected().variants.webp.slice(0, 2),
        );
    },
  );

  it('rejects a partial 192/384 manifest instead of loosening the strict storage schema', async () => {
    await writeFile(
      fixture.ready,
      JSON.stringify({
        ...fixture.manifest,
        candidates: fixture.manifest.candidates.slice(0, 2),
      }),
    );
    expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
  });

  it.each([
    'JSON',
    'size',
    'path',
    'profile',
    'source',
    'fingerprint',
  ] as const)('falls back for corrupt manifest %s', async (kind) => {
    const manifest = structuredClone(fixture.manifest);
    let raw: Buffer;
    if (kind === 'JSON') raw = Buffer.from('{"source":');
    else if (kind === 'size') raw = Buffer.alloc(16 * 1024 + 1, 32);
    else {
      if (kind === 'path')
        manifest.candidates[0]!.url = '/uploads/products/../../secret.webp';
      if (kind === 'profile') manifest.profile.version = 'v2' as 'v1';
      if (kind === 'source') manifest.source.url = imageUrl(2);
      if (kind === 'fingerprint') manifest.source.fingerprint.ino = '0';
      raw = Buffer.from(JSON.stringify(manifest));
    }
    await writeFile(fixture.ready, raw);
    expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
  });

  it('checks actual header dimensions even when a misleading manifest checksum matches the bytes', async () => {
    const manifest = structuredClone(fixture.manifest);
    manifest.candidates[0]!.width--;
    manifest.candidates[0]!.height--;
    await writeFile(fixture.ready, JSON.stringify(manifest));
    const result = await readonly(() => registry.metadata(imageUrl()));
    expect(result?.variants.webp).toEqual(expected().variants.webp.slice(1));
  });

  it.each([
    '../private.webp',
    '/uploads/products/%2e%2e.webp',
    imageUrl() + '?x=1',
    imageUrl() + '\n',
    imageUrl().replace('/products/', '/products\\'),
    'https://example.com/image.webp',
    'C:\\private\\image.webp',
  ])(
    'rejects untrusted image URL %j without disk or network access',
    async (url) => {
      expect(await registry.metadata(url)).toBeNull();
      expect(open).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
    },
  );

  it('detects an original change on a hot cache entry before positive TTL expires', async () => {
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    await writeFile(fixture.original, Buffer.alloc(fixture.source.length, 32));
    expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
  });

  it('detects a changed original even with restored mtime and matching size', async () => {
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    const before = await native.stat(fixture.original);
    await writeFile(fixture.original, Buffer.alloc(fixture.source.length, 32));
    await utimes(fixture.original, before.atime, before.mtime);
    expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
  });

  it('drops a disappeared variant immediately on cache hit and recovers after files return', async () => {
    const candidate = fixture.manifest.candidates[2]!;
    const path = fixture.path(candidate.url);
    const buffer = await readFile(path);
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    await unlink(path);
    expect(
      (await readonly(() => registry.metadata(imageUrl())))?.variants.webp,
    ).toHaveLength(2);
    await writeFile(path, buffer, { flag: 'wx' });
    expect(
      (await readonly(() => registry.metadata(imageUrl())))?.variants.webp,
    ).toHaveLength(3);
  });

  it('coalesces concurrent duplicates and avoids body reads on positive cache hits', async () => {
    const values = await readonly(() =>
      Promise.all(
        Array.from({ length: 60 }, () => registry.metadata(imageUrl())),
      ),
    );
    expect(values.every((value) => value !== null)).toBe(true);
    expect(open).toHaveBeenCalledTimes(5);
    vi.mocked(open).mockClear();
    const batch = Array.from({ length: 60 }, (_, id) => ({
      id,
      images: [
        { url: imageUrl(), alt: null },
        { url: imageUrl(), alt: 'duplicate' },
      ],
    }));
    expect(await readonly(() => registry.enrich(batch))).toHaveLength(60);
    expect(open).not.toHaveBeenCalled();
    values[0]!.variants.webp[0]!.width = 1;
    expect(await registry.metadata(imageUrl())).toEqual(expected());
  });

  it('uses finite positive/negative TTL, including recovery after a missing manifest', async () => {
    let now = 0;
    registry = new ImageRegistry({ ...fixture.options, now: () => now });
    const ready = await readFile(fixture.ready);
    await unlink(fixture.ready);
    expect(await registry.metadata(imageUrl())).toBeNull();
    await writeFile(fixture.ready, ready);
    expect(await registry.metadata(imageUrl())).toBeNull();
    now = 5_001;
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    vi.mocked(open).mockClear();
    now += 30_001;
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    expect(open).toHaveBeenCalledTimes(5);
  });

  it('evicts by LRU entry count and bounds accounted cache bytes', async () => {
    await fixture.add(2);
    await fixture.add(3);
    registry = new ImageRegistry({
      ...fixture.options,
      cache: { maxEntries: 2 },
    });
    await registry.metadata(imageUrl());
    await registry.metadata(imageUrl(2));
    await registry.metadata(imageUrl(3));
    vi.mocked(open).mockClear();
    await registry.metadata(imageUrl());
    expect(open).toHaveBeenCalledTimes(5);
    registry = new ImageRegistry({
      ...fixture.options,
      cache: { maxBytes: 1 },
    });
    vi.mocked(open).mockClear();
    await registry.metadata(imageUrl());
    await registry.metadata(imageUrl());
    expect(open).toHaveBeenCalledTimes(10);
  });

  it('limits global file-I/O concurrency when many unique images arrive together', async () => {
    let active = 0;
    let peak = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((done) => setImmediate(done));
        return await native.lstat(...args);
      } finally {
        active--;
      }
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        registry.metadata(imageUrl(index + 1)),
      ),
    );
    expect(peak).toBe(4);
  });

  it('returns legacy products on filesystem failures instead of rejecting the catalogue', async () => {
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error('private /secret EIO'), { code: 'EIO' }),
    );
    const products = [{ id: 1, images: [{ url: imageUrl(), alt: null }] }];
    expect(await readonly(() => registry.enrich(products))).toEqual(products);
  });

  it.each(['private root', 'variant parent'] as const)(
    'rejects symlink/junction at %s',
    async (location) => {
      if (location === 'private root') {
        const alias = join(fixture.root, 'alias');
        await symlink(
          fixture.stateRoot,
          alias,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        registry = new ImageRegistry({ ...fixture.options, stateRoot: alias });
      } else {
        const variants = join(fixture.publicRoot, 'variants');
        await rename(variants, join(fixture.root, 'kept-variants'));
        await symlink(
          join(fixture.root, 'outside'),
          variants,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
    },
  );

  it('rejects replacement of a previously pinned root', async () => {
    expect(await registry.metadata(imageUrl())).not.toBeNull();
    await rename(fixture.stateRoot, join(fixture.root, 'old-state'));
    await native.mkdir(fixture.stateRoot, { mode: 0o700 });
    expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
  });

  it
    .skipIf(process.platform !== 'linux')
    .each(['source', 'variant', 'manifest'] as const)(
    'Linux: rejects native %s file symlinks',
    async (kind) => {
      const path =
        kind === 'source'
          ? fixture.original
          : kind === 'manifest'
            ? fixture.ready
            : fixture.path(fixture.manifest.candidates[0]!.url);
      const target = join(fixture.root, 'saved');
      await rename(path, target);
      await symlink(target, path, 'file');
      expect(await readonly(() => registry.metadata(imageUrl()))).toBeNull();
    },
  );

  it('does not serve a URL absent from the strict READY manifest', async () => {
    const url = imageVariantUrl(
      imageId(),
      fixture.manifest.source.sha256,
      192,
      'f'.repeat(64),
    );
    expect(await readonly(() => registry.variant(url))).toBeNull();
  });
});
