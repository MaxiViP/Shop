import { z } from 'zod';
import {
  IMAGE_VARIANT_PROFILES,
  IMAGE_VARIANT_SIZES,
  type ImageVariantSize,
} from './image-variants.js';

export const MAX_IMAGE_MANIFEST_BYTES = 16 * 1024;
const uuid =
  '[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const digest = '[0-9a-f]{64}';
const sourcePattern = new RegExp(`^/uploads/products/(${uuid})\\.webp$`);
const variantPattern = new RegExp(
  `^/uploads/products/variants/(v1)/(${uuid})/(${digest})/(192|384|640)(?:-(${digest}))?\\.webp$`,
);
const sha256 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const size = z.union([z.literal(192), z.literal(384), z.literal(640)]);
const uint = z
  .string()
  .min(1)
  .max(30)
  .regex(/^(0|[1-9][0-9]*)(?![\s\S])/);

export class ImageManifestError extends Error {
  constructor() {
    super('Invalid product image manifest or URL');
    this.name = 'ImageManifestError';
  }
}

export function productImageId(url: string): string {
  const match = typeof url === 'string' ? sourcePattern.exec(url) : null;
  if (!match || match[0] !== url) throw new ImageManifestError();
  return match[1]!;
}

export function parseVariantUrl(url: string) {
  const match = typeof url === 'string' ? variantPattern.exec(url) : null;
  if (!match || match[0] !== url) throw new ImageManifestError();
  return {
    profile: match[1]!,
    id: match[2]!,
    sourceHash: match[3]!,
    size: Number(match[4]) as ImageVariantSize,
    outputHash: match[5],
  };
}

export function imageVariantUrl(
  id: string,
  sourceHash: string,
  bound: ImageVariantSize,
  outputHash?: string,
): string {
  productImageId(`/uploads/products/${id}.webp`);
  const url = `/uploads/products/variants/v1/${id}/${sourceHash}/${bound}${outputHash ? `-${outputHash}` : ''}.webp`;
  parseVariantUrl(url);
  return url;
}

const sourceUrl = z.string().refine((url) => {
  try {
    productImageId(url);
    return true;
  } catch {
    return false;
  }
});
const variantUrl = z.string().refine((url) => {
  try {
    parseVariantUrl(url);
    return true;
  } catch {
    return false;
  }
});
const candidateSchema = z.strictObject({
  url: variantUrl,
  sizes: z.array(size).min(1).max(3),
  width: z.number().int().min(1).max(640),
  height: z.number().int().min(1).max(640),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024),
  sha256,
});

export const imageManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    profile: z.strictObject({
      version: z.literal('v1'),
      quality: z.literal(IMAGE_VARIANT_PROFILES.v1.quality),
      alphaQuality: z.literal(IMAGE_VARIANT_PROFILES.v1.alphaQuality),
      effort: z.literal(IMAGE_VARIANT_PROFILES.v1.effort),
    }),
    source: z.strictObject({
      url: sourceUrl,
      format: z.literal('webp'),
      width: z.number().int().min(1).max(16384),
      height: z.number().int().min(1).max(16384),
      bytes: z
        .number()
        .int()
        .min(1)
        .max(5 * 1024 * 1024),
      sha256,
      fingerprint: z.strictObject({ mtimeNs: uint, dev: uint, ino: uint }),
    }),
    candidates: z.array(candidateSchema).min(1).max(3),
  })
  .superRefine((manifest, context) => {
    const invalid = () =>
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent image manifest',
      });
    const source = manifest.source;
    if (source.width * source.height > 25_000_000) invalid();
    let id: string;
    try {
      id = productImageId(source.url);
    } catch {
      return;
    }
    const bounds = manifest.candidates.flatMap((candidate) => candidate.sizes);
    if (bounds.join(',') !== IMAGE_VARIANT_SIZES.join(',')) invalid();
    if (
      new Set(manifest.candidates.map((candidate) => candidate.url)).size !==
      manifest.candidates.length
    )
      invalid();
    for (const candidate of manifest.candidates) {
      try {
        const path = parseVariantUrl(candidate.url);
        if (
          path.id !== id ||
          path.sourceHash !== source.sha256 ||
          path.size !== candidate.sizes[0] ||
          (path.outputHash !== undefined &&
            path.outputHash !== candidate.sha256)
        )
          invalid();
      } catch {
        continue;
      }
      for (const bound of candidate.sizes) {
        const scale = Math.min(1, bound / source.width, bound / source.height);
        if (
          candidate.width > Math.min(bound, source.width) ||
          candidate.height > Math.min(bound, source.height) ||
          Math.abs(candidate.width - source.width * scale) > 1 ||
          Math.abs(candidate.height - source.height * scale) > 1
        )
          invalid();
      }
    }
  });

export type ImageManifest = z.infer<typeof imageManifestSchema>;
export type ImageCandidate = ImageManifest['candidates'][number];

export function parseImageManifest(buffer: Buffer): ImageManifest {
  try {
    if (
      !Buffer.isBuffer(buffer) ||
      !buffer.length ||
      buffer.length > MAX_IMAGE_MANIFEST_BYTES
    )
      throw new ImageManifestError();
    // JSON cannot represent bigint: fingerprint integers are decimal strings.
    return imageManifestSchema.parse(JSON.parse(buffer.toString('utf8')));
  } catch {
    throw new ImageManifestError();
  }
}

export function encodeImageManifest(value: unknown): Buffer {
  try {
    const buffer = Buffer.from(
      JSON.stringify(imageManifestSchema.parse(value)) + '\n',
    );
    if (buffer.length > MAX_IMAGE_MANIFEST_BYTES)
      throw new ImageManifestError();
    return buffer;
  } catch {
    throw new ImageManifestError();
  }
}
