import {
  encodeImageManifest,
  imageVariantUrl,
  ImageManifestError,
  MAX_IMAGE_MANIFEST_BYTES,
  parseImageManifest,
  parseVariantUrl,
  productImageId,
  type ImageManifest,
} from './image-manifest.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const sourceHash = 'a'.repeat(64);
const outputHash = 'b'.repeat(64);
const sourceUrl = `/uploads/products/${id}.webp`;
const fixture = (): ImageManifest => ({
  schemaVersion: 1,
  profile: { version: 'v1', quality: 82, alphaQuality: 100, effort: 4 },
  source: {
    url: sourceUrl,
    format: 'webp',
    width: 1024,
    height: 1024,
    bytes: 12345,
    sha256: sourceHash,
    fingerprint: { mtimeNs: '1792044000000000000', dev: '1', ino: '42' },
  },
  candidates: ([192, 384, 640] as const).map((size) => ({
    url: imageVariantUrl(id, sourceHash, size),
    sizes: [size],
    width: size,
    height: size,
    bytes: 1000,
    sha256: outputHash,
  })),
});

describe('product image manifest', () => {
  it('round trips a strict bounded manifest including fingerprint and encoding profile', () => {
    const value = fixture();
    const buffer = encodeImageManifest(value);
    expect(buffer.length).toBeLessThanOrEqual(MAX_IMAGE_MANIFEST_BYTES);
    expect(parseImageManifest(buffer)).toEqual(value);
  });

  it.each([
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-81d4-a716-446655440000',
  ])('accepts managed UUID v4/v8 %s', (value) => {
    expect(productImageId(`/uploads/products/${value}.webp`)).toBe(value);
  });

  it.each([
    '../secret.webp',
    `/uploads/products/../${id}.webp`,
    `/uploads/products/%2e%2e/${id}.webp`,
    `/uploads/products/${id}%2f.webp`,
    `/uploads/products/${id}.webp?x=1`,
    `/uploads/products/${id}.webp#x`,
    `/uploads/products/${id}.webp\n`,
    `/uploads/products/${id}.webp\0`,
    `/uploads/products/${id.toUpperCase()}.webp`,
    '/uploads/products/550e8400-e29b-71d4-a716-446655440000.webp',
    '/uploads/products/550e8400-e29b-41d4-0716-446655440000.webp',
    `/uploads/products\\${id}.webp`,
    `https://example.com/uploads/products/${id}.webp`,
    `C:\\uploads\\${id}.webp`,
    `/uploads/products/${id}.webp:secret`,
  ])('rejects noncanonical source URL %j', (url) => {
    expect(() => productImageId(url)).toThrow(ImageManifestError);
  });

  it('supports deterministic repair URLs bound to the actual output checksum', () => {
    const value = fixture();
    value.candidates[0]!.url = imageVariantUrl(id, sourceHash, 192, outputHash);
    expect(parseVariantUrl(value.candidates[0]!.url)).toEqual({
      profile: 'v1',
      id,
      sourceHash,
      size: 192,
      outputHash,
    });
    expect(parseImageManifest(encodeImageManifest(value))).toEqual(value);
  });

  it('allows one physical candidate shared by all sizes for a tiny source', () => {
    const value = fixture();
    value.source.width = 80;
    value.source.height = 40;
    value.candidates = [
      {
        ...value.candidates[0]!,
        sizes: [192, 384, 640],
        width: 80,
        height: 40,
      },
    ];
    expect(parseImageManifest(encodeImageManifest(value))).toEqual(value);
  });

  it.each([
    [
      'schema version',
      (value: ImageManifest) => ({ ...value, schemaVersion: 2 }),
    ],
    [
      'profile',
      (value: ImageManifest) => ({
        ...value,
        profile: { ...value.profile, quality: 85 },
      }),
    ],
    [
      'extra top-level key',
      (value: ImageManifest) => ({ ...value, path: '/private/secret' }),
    ],
    [
      'extra source key',
      (value: ImageManifest) => ({
        ...value,
        source: { ...value.source, path: '/private/secret' },
      }),
    ],
    [
      'extra candidate key',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          { ...value.candidates[0], path: '/secret' },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'incomplete set',
      (value: ImageManifest) => ({
        ...value,
        candidates: value.candidates.slice(1),
      }),
    ],
    [
      'duplicate sizes',
      (value: ImageManifest) => ({
        ...value,
        candidates: [value.candidates[0], ...value.candidates],
      }),
    ],
    [
      'wrong source hash',
      (value: ImageManifest) => ({
        ...value,
        source: { ...value.source, sha256: 'c'.repeat(64) },
      }),
    ],
    [
      'pixel limit',
      (value: ImageManifest) => ({
        ...value,
        source: { ...value.source, width: 6000, height: 6000 },
      }),
    ],
    [
      'input byte limit',
      (value: ImageManifest) => ({
        ...value,
        source: { ...value.source, bytes: 5 * 1024 * 1024 + 1 },
      }),
    ],
    [
      'zero dimension',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          { ...value.candidates[0], width: 0 },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'wrong dimensions',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          { ...value.candidates[0], width: 100 },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'output byte limit',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          { ...value.candidates[0], bytes: 2 * 1024 * 1024 + 1 },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'negative fingerprint',
      (value: ImageManifest) => ({
        ...value,
        source: {
          ...value.source,
          fingerprint: { ...value.source.fingerprint, ino: '-1' },
        },
      }),
    ],
    [
      'noncanonical fingerprint',
      (value: ImageManifest) => ({
        ...value,
        source: {
          ...value.source,
          fingerprint: { ...value.source.fingerprint, ino: '42\n' },
        },
      }),
    ],
    [
      'noncanonical hash',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          { ...value.candidates[0], sha256: 'b'.repeat(63) + '\n' },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'repair hash mismatch',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          {
            ...value.candidates[0],
            url: imageVariantUrl(id, sourceHash, 192, 'c'.repeat(64)),
          },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'different UUID',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          {
            ...value.candidates[0],
            url: imageVariantUrl(
              '550e8400-e29b-41d4-a716-446655440001',
              sourceHash,
              192,
            ),
          },
          ...value.candidates.slice(1),
        ],
      }),
    ],
    [
      'different profile namespace',
      (value: ImageManifest) => ({
        ...value,
        candidates: [
          {
            ...value.candidates[0],
            url: value.candidates[0]!.url.replace('/v1/', '/v2/'),
          },
          ...value.candidates.slice(1),
        ],
      }),
    ],
  ] as const)('rejects %s', (_name, alter) => {
    expect(() => encodeImageManifest(alter(fixture()))).toThrow(
      ImageManifestError,
    );
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from('{"secret":'),
    Buffer.alloc(MAX_IMAGE_MANIFEST_BYTES + 1, 32),
  ])('rejects malformed or oversized JSON with a sanitized error', (buffer) => {
    try {
      parseImageManifest(buffer);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ImageManifestError);
      expect((error as Error).message).toBe(
        'Invalid product image manifest or URL',
      );
      expect(error).not.toHaveProperty('cause');
    }
  });
});
