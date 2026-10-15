import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import {
  generateImageVariants,
  IMAGE_VARIANT_PROFILES,
  IMAGE_VARIANT_SIZES,
  ImageVariantsError,
  type ImageVariantProfile,
  type ImageVariants,
} from './image-variants.js';

const hash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');
const photo = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background: '#316b9d' } });

async function verify(result: ImageVariants) {
  expect(result.profile).toBe('v1');
  expect(result.variants.flatMap((variant) => variant.sizes)).toEqual(
    IMAGE_VARIANT_SIZES,
  );
  for (const variant of result.variants) {
    const metadata = await sharp(variant.buffer).metadata();
    expect(metadata).toMatchObject({
      format: 'webp',
      width: variant.width,
      height: variant.height,
      hasProfile: false,
    });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(variant.bytes).toBe(variant.buffer.length);
    expect(variant.sha256).toBe(hash(variant.buffer));
    expect(variant.bytes).toBeGreaterThan(0);
    expect(variant.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    // This decodes every returned pixel, independently of generator metadata.
    const { info } = await sharp(variant.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(variant.width);
    expect(info.height).toBe(variant.height);
    for (const size of variant.sizes) {
      expect(variant.width).toBeLessThanOrEqual(
        Math.min(size, result.source.width),
      );
      expect(variant.height).toBeLessThanOrEqual(
        Math.min(size, result.source.height),
      );
    }
  }
}

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

// A valid two-frame APNG: libvips may expose only its default PNG image.
async function animatedPng() {
  const frames = await Promise.all([
    photo(2, 2).png().toBuffer(),
    sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer(),
  ]);
  const idat = (buffer: Buffer) => {
    const chunks: Buffer[] = [];
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT')
        chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    return Buffer.concat(chunks);
  };
  const control = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(2, 4);
    data.writeUInt32BE(2, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk('fcTL', data);
  };
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const second = Buffer.alloc(4);
  second.writeUInt32BE(2);
  return Buffer.concat([
    frames[0]!.subarray(0, 33),
    pngChunk('acTL', animation),
    control(0),
    pngChunk('IDAT', idat(frames[0]!)),
    control(1),
    pngChunk('fdAT', Buffer.concat([second, idat(frames[1]!)])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('product image variants', () => {
  it.each([
    [
      'square',
      960,
      960,
      [
        [192, 192],
        [384, 384],
        [640, 640],
      ],
    ],
    [
      'portrait',
      600,
      1200,
      [
        [96, 192],
        [192, 384],
        [320, 640],
      ],
    ],
    [
      'landscape',
      1200,
      600,
      [
        [192, 96],
        [384, 192],
        [640, 320],
      ],
    ],
    [
      'odd dimensions',
      1001,
      667,
      [
        [192, 127],
        [384, 256],
        [640, 426],
      ],
    ],
  ] as const)(
    'fits a %s image inside each bounding size',
    async (_name, width, height, expected) => {
      const source = await photo(width, height).jpeg().toBuffer();
      const result = await generateImageVariants(source);
      expect(result.source).toEqual({
        format: 'jpeg',
        width,
        height,
        bytes: source.length,
        sha256: hash(source),
      });
      expect(
        result.variants.map((variant) => [variant.width, variant.height]),
      ).toEqual(expected);
      for (const variant of result.variants)
        expect(
          Math.abs(variant.height - (variant.width * height) / width),
        ).toBeLessThanOrEqual(1);
      await verify(result);
    },
  );

  it('keeps all four corners without cropping or adding a background', async () => {
    const tile = (background: string) =>
      sharp({ create: { width: 600, height: 300, channels: 3, background } })
        .png()
        .toBuffer();
    const source = await photo(1200, 600)
      .composite([
        { input: await tile('red'), left: 0, top: 0 },
        { input: await tile('lime'), left: 600, top: 0 },
        { input: await tile('blue'), left: 0, top: 300 },
        { input: await tile('yellow'), left: 600, top: 300 },
      ])
      .png()
      .toBuffer();
    const result = await generateImageVariants(source);
    for (const variant of result.variants) {
      const { data, info } = await sharp(variant.buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [
        ...data.subarray(
          (y * info.width + x) * info.channels,
          (y * info.width + x) * info.channels + 3,
        ),
      ];
      const expected = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
      ];
      const corners = [
        pixel(5, 5),
        pixel(info.width - 6, 5),
        pixel(5, info.height - 6),
        pixel(info.width - 6, info.height - 6),
      ];
      corners.forEach((actual, index) =>
        actual.forEach((channel, band) =>
          expect(
            Math.abs(channel - expected[index]![band]!),
          ).toBeLessThanOrEqual(5),
        ),
      );
    }
  });

  it.each(['png', 'webp'] as const)(
    'preserves fully transparent, translucent and opaque pixels from %s',
    async (format) => {
      const raw = Buffer.alloc(960 * 480 * 4);
      for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 960; x++) {
          const offset = (y * 960 + x) * 4;
          raw[offset] = 80;
          raw[offset + 1] = 140;
          raw[offset + 2] = 200;
          raw[offset + 3] = x < 320 ? 0 : x < 640 ? 128 : 255;
        }
      }
      const image = sharp(raw, {
        raw: { width: 960, height: 480, channels: 4 },
      });
      const source = await (
        format === 'png' ? image.png() : image.webp({ lossless: true })
      ).toBuffer();
      const result = await generateImageVariants(source);
      await verify(result);
      for (const variant of result.variants) {
        const { data, info } = await sharp(variant.buffer)
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(info.channels).toBe(4);
        const alphaAt = (fraction: number) =>
          data[
            (Math.floor(info.height / 2) * info.width +
              Math.floor(info.width * fraction)) *
              4 +
              3
          ];
        expect(alphaAt(1 / 6)).toBe(0);
        expect(alphaAt(1 / 2)).toBe(128);
        expect(alphaAt(5 / 6)).toBe(255);
      }
    },
  );

  it('accepts opaque RGBA PNG even if WebP drops its redundant alpha channel', async () => {
    await verify(
      await generateImageVariants(await photo(240, 160, 4).png().toBuffer()),
    );
  });

  it.each([
    [1, 120, 80, [255, 0, 0]],
    [2, 120, 80, [0, 255, 0]],
    [6, 80, 120, [0, 0, 255]],
    [8, 80, 120, [0, 255, 0]],
  ] as const)(
    'applies EXIF orientation %i including mirroring and strips metadata',
    async (orientation, width, height, topLeft) => {
      const tile = (background: string) =>
        sharp({ create: { width: 60, height: 40, channels: 3, background } })
          .png()
          .toBuffer();
      const source = await photo(120, 80)
        .composite([
          { input: await tile('red'), left: 0, top: 0 },
          { input: await tile('lime'), left: 60, top: 0 },
          { input: await tile('blue'), left: 0, top: 40 },
          { input: await tile('yellow'), left: 60, top: 40 },
        ])
        .withMetadata({ orientation })
        .jpeg({ quality: 100 })
        .toBuffer();
      expect((await sharp(source).metadata()).orientation).toBe(orientation);
      const result = await generateImageVariants(source);
      expect(result.source).toMatchObject({ width, height });
      expect(result.variants).toHaveLength(1);
      expect(result.variants[0]).toMatchObject({
        width,
        height,
        sizes: [192, 384, 640],
      });
      await verify(result);
      const { data, info } = await sharp(result.variants[0]!.buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixel = [
        ...data.subarray(
          (10 * info.width + 10) * info.channels,
          (10 * info.width + 10) * info.channels + 3,
        ),
      ];
      pixel.forEach((channel, band) =>
        expect(Math.abs(channel - topLeft[band]!)).toBeLessThanOrEqual(5),
      );
    },
  );

  it.each([
    [80, 40, [[192, 384, 640]]],
    [192, 96, [[192, 384, 640]]],
    [300, 150, [[192], [384, 640]]],
    [384, 192, [[192], [384, 640]]],
    [500, 250, [[192], [384], [640]]],
  ] as const)(
    'does not enlarge %ix%i and shares identical outputs',
    async (width, height, sizes) => {
      const result = await generateImageVariants(
        await photo(width, height).png().toBuffer(),
      );
      expect(result.variants.map((variant) => variant.sizes)).toEqual(sizes);
      expect(result.variants.at(-1)).toMatchObject({ width, height });
      expect(
        new Set(result.variants.map((variant) => variant.sha256)).size,
      ).toBe(result.variants.length);
      await verify(result);
    },
  );

  it('uses the fixed v1 quality profile and produces repeatable bytes', async () => {
    expect(IMAGE_VARIANT_PROFILES.v1).toEqual({
      quality: 82,
      alphaQuality: 100,
      effort: 4,
    });
    expect(Object.isFrozen(IMAGE_VARIANT_PROFILES)).toBe(true);
    expect(Object.isFrozen(IMAGE_VARIANT_PROFILES.v1)).toBe(true);
    const source = await photo(240, 120).jpeg().toBuffer();
    expect(await generateImageVariants(source, 'v1')).toEqual(
      await generateImageVariants(source),
    );
    for (const profile of ['v2', '__proto__', 'constructor'])
      await expect(
        generateImageVariants(source, profile as ImageVariantProfile),
      ).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
  });

  it.each(['gif', 'tiff', 'svg', 'html'] as const)(
    'rejects unsupported %s input by its content',
    async (format) => {
      const source =
        format === 'svg'
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
            )
          : format === 'html'
            ? Buffer.from('<html>private-file-content</html>')
            : await photo(16, 16)[format]().toBuffer();
      await expect(generateImageVariants(source)).rejects.toMatchObject({
        code: 'UNSUPPORTED_FORMAT',
      });
    },
  );

  it('rejects animated WebP rather than silently using its first frame', async () => {
    const source = await sharp({
      create: {
        width: 16,
        height: 32,
        pageHeight: 16,
        channels: 3,
        background: 'red',
      },
    })
      .composite([
        { input: await photo(16, 16).png().toBuffer(), left: 0, top: 16 },
      ])
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(source).metadata()).pages).toBe(2);
    await expect(generateImageVariants(source)).rejects.toMatchObject({
      code: 'ANIMATED_IMAGE',
    });
  });

  it('rejects APNG even when the decoder reports a single default frame', async () => {
    const source = await animatedPng();
    expect((await sharp(source).metadata()).format).toBe('png');
    await sharp(source).stats();
    await expect(generateImageVariants(source)).rejects.toMatchObject({
      code: 'ANIMATED_IMAGE',
    });
  });

  it('does not confuse PNG text containing acTL with an animation chunk', async () => {
    const source = await photo(240, 160).png().toBuffer();
    const text = pngChunk('tEXt', Buffer.from('Comment\0acTL is only text'));
    const withText = Buffer.concat([
      source.subarray(0, 33),
      text,
      source.subarray(33),
    ]);
    await verify(await generateImageVariants(withText));
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    'rejects a truncated %s, including readable headers',
    async (format) => {
      const source = await photo(960, 640)[format]().toBuffer();
      const truncated = source.subarray(
        0,
        source.length - (format === 'jpeg' ? 2 : 20),
      );
      if (format === 'jpeg')
        expect((await sharp(truncated).metadata()).format).toBe('jpeg');
      await expect(generateImageVariants(truncated)).rejects.toBeInstanceOf(
        ImageVariantsError,
      );
    },
  );

  it('rejects malformed PNG chunk lengths without out-of-bounds reads', async () => {
    const source = await photo(10, 10).png().toBuffer();
    source.writeUInt32BE(0xffffffff, 8);
    await expect(generateImageVariants(source)).rejects.toMatchObject({
      code: 'INVALID_IMAGE',
    });
  });

  it('rejects PNG with a corrupt ancillary chunk checksum', async () => {
    const source = await photo(10, 10).png().toBuffer();
    const text = pngChunk('tEXt', Buffer.from('Comment\0damaged metadata'));
    text[text.length - 1] = text[text.length - 1]! ^ 1;
    const corrupt = Buffer.concat([
      source.subarray(0, 33),
      text,
      source.subarray(33),
    ]);
    await expect(generateImageVariants(corrupt)).rejects.toMatchObject({
      code: 'INVALID_IMAGE',
    });
  });

  it('rejects empty, non-buffer and corrupt inputs with sanitized errors', async () => {
    const inputs: unknown[] = [
      Buffer.alloc(0),
      '/private/photos/secret.jpg',
      undefined,
      Buffer.from('private-file-content'),
      Buffer.from([0xff, 0xd8, 0xff, 0, 0]),
    ];
    for (const input of inputs) {
      const error: unknown = await generateImageVariants(input as Buffer).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ImageVariantsError);
      expect(error).not.toHaveProperty('cause');
      expect((error as Error).message).not.toMatch(
        /private|secret|ENOENT|Input buffer|Vips/i,
      );
    }
  });

  it('rejects more than 5 MiB by the real buffer length', async () => {
    const source = Buffer.alloc(5 * 1024 * 1024 + 1);
    await expect(generateImageVariants(source)).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });
  });

  it('rejects a valid compressed image above 25 megapixels', async () => {
    const source = await photo(5001, 5000).png().toBuffer();
    expect(source.length).toBeLessThan(5 * 1024 * 1024);
    await expect(generateImageVariants(source)).rejects.toBeInstanceOf(
      ImageVariantsError,
    );
  });

  it.each([
    [16385, 1],
    [1, 16385],
  ])(
    'rejects excessive edges %ix%i even below the pixel limit',
    async (width, height) => {
      const source = await photo(width, height).png().toBuffer();
      await expect(generateImageVariants(source)).rejects.toMatchObject({
        code: 'INVALID_DIMENSIONS',
      });
    },
  );

  it('accepts the maximum edge without enlargement', async () => {
    const result = await generateImageVariants(
      await photo(16384, 32).png().toBuffer(),
    );
    await verify(result);
  });

  it('rejects zero dimensions', async () => {
    const source = await photo(2, 2).png().toBuffer();
    const header = Buffer.from(source.subarray(16, 29));
    header.writeUInt32BE(0, 0);
    const invalid = Buffer.concat([
      source.subarray(0, 8),
      pngChunk('IHDR', header),
      source.subarray(33),
    ]);
    await expect(generateImageVariants(invalid)).rejects.toBeInstanceOf(
      ImageVariantsError,
    );
  });

  it('snapshots input so caller mutation cannot alter the validated source', async () => {
    const source = await photo(240, 160).png().toBuffer();
    const snapshot = Buffer.from(source);
    const promise = generateImageVariants(source);
    source.fill(0);
    const result = await promise;
    expect(result.source.sha256).toBe(hash(snapshot));
    await verify(result);
  });
});

describe('original preservation on disk', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'korzina-image-variants-test-'));
  });
  afterEach(async () => {
    const target = resolve(root);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !target.startsWith(
        resolve(tmpdir()) + sep + 'korzina-image-variants-test-',
      )
    )
      throw new Error('Unsafe test directory');
    await rm(target, { recursive: true, force: true });
  });

  async function checkFile(path: string) {
    const before = await readFile(path);
    const originalHash = hash(before);
    const originalStat = await stat(path);
    const result = await generateImageVariants(before);
    await verify(result);
    expect(result.source.sha256).toBe(originalHash);
    for (const variant of result.variants) {
      const output = join(root, `${variant.sizes[0]}.webp`);
      await writeFile(output, variant.buffer, { flag: 'wx' });
      expect(hash(await readFile(output))).toBe(variant.sha256);
    }
    expect(before).toEqual(await readFile(path));
    expect(hash(await readFile(path))).toBe(originalHash);
    const currentStat = await stat(path);
    expect(currentStat.size).toBe(originalStat.size);
    expect(currentStat.mtimeMs).toBe(originalStat.mtimeMs);
    return { result, originalHash };
  }

  it('preserves original bytes, SHA-256 and mtime while writing only temp outputs', async () => {
    const source = await photo(960, 640).jpeg().toBuffer();
    const path = join(root, 'source.jpg');
    await writeFile(path, source, { flag: 'wx' });
    await checkFile(path);
  });

  const samples = [
    'vkusnaya-stall/vkusnaya-stall-stuffed-peppers-500g.webp',
    'oktyabrskoe-moloko/oktyabrskoe-moloko-milk-32-1l.webp',
    'borisovskie-syry/borisovskie-syry-brie-200-250g.webp',
  ];
  it.each(samples)(
    'verifies repository sample %s without modifying it',
    async (sample) => {
      const path = new URL(
        `../../data/product-photos/2026-10-07/${sample}`,
        import.meta.url,
      );
      const { originalHash } = await checkFile(fileURLToPath(path));
      const manifest = JSON.parse(
        await readFile(
          new URL(
            '../../data/product-photos/2026-10-07/manifest.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        products: { slug: string; sha256: string }[];
      };
      const entry = manifest.products.find((row) =>
        sample.endsWith(`/${row.slug}.webp`),
      );
      expect(entry?.sha256).toBe(originalHash);
    },
  );
});
