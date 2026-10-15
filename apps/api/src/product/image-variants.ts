import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp, { type Metadata } from 'sharp';

export const IMAGE_VARIANT_SIZES = Object.freeze([192, 384, 640] as const);
export const IMAGE_VARIANT_PROFILES = Object.freeze({
  v1: Object.freeze({ quality: 82, alphaQuality: 100, effort: 4 }),
});

export type ImageVariantProfile = keyof typeof IMAGE_VARIANT_PROFILES;
export type ImageVariantSize = (typeof IMAGE_VARIANT_SIZES)[number];

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_EDGE = 16_384;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const errors = {
  INVALID_INPUT: 'Expected a non-empty image buffer',
  INPUT_TOO_LARGE: 'Image exceeds the 5 MiB input limit',
  UNSUPPORTED_FORMAT: 'Only JPEG, PNG and WebP images are allowed',
  ANIMATED_IMAGE: 'Animated images are not allowed',
  INVALID_DIMENSIONS: 'Image exceeds 25 megapixels or a 16384 px edge',
  INVALID_IMAGE: 'Image is damaged or exceeds the decoder limits',
  INVALID_PROFILE: 'Unknown image variant profile',
  PROCESSING_FAILED: 'Could not generate valid image variants',
} as const;

export class ImageVariantsError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code]);
    this.name = 'ImageVariantsError';
  }
}

export interface ImageVariant {
  // Several bounding sizes can share one output when the source is small.
  sizes: ImageVariantSize[];
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface ImageVariants {
  profile: ImageVariantProfile;
  source: {
    format: 'jpeg' | 'png' | 'webp';
    width: number;
    height: number;
    bytes: number;
    sha256: string;
  };
  variants: ImageVariant[];
}

const hash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

function inputFormat(source: Buffer): ImageVariants['source']['format'] {
  if (source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff)
    return 'jpeg';
  if (source.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (
    source.toString('ascii', 0, 4) === 'RIFF' &&
    source.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  throw new ImageVariantsError('UNSUPPORTED_FORMAT');
}

function assertStaticPng(source: Buffer) {
  // Sharp/libvips can report only the default PNG frame for APNG. Walk real
  // chunks (not a substring search) to reject its animation control chunk.
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    if (length > source.length - offset - 12) break;
    if (
      crc32(source.subarray(offset + 4, offset + 8 + length)) !==
      source.readUInt32BE(offset + 8 + length)
    )
      throw new ImageVariantsError('INVALID_IMAGE');
    const type = source.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw new ImageVariantsError('ANIMATED_IMAGE');
    offset += length + 12;
    if (type === 'IEND' && length === 0 && offset === source.length) return;
  }
  throw new ImageVariantsError('INVALID_IMAGE');
}

/**
 * Pure buffer-to-buffer generator: no paths, filesystem writes or global Sharp
 * settings. Profiles are immutable; change the version when changing encoding.
 * Callers must bound job concurrency and use a supervised process for hard
 * RSS/deadline limits. The Sharp timeout below is only a native encode timeout.
 */
export async function generateImageVariants(
  input: Buffer,
  profile: ImageVariantProfile = 'v1',
): Promise<ImageVariants> {
  if (!Buffer.isBuffer(input) || input.length === 0)
    throw new ImageVariantsError('INVALID_INPUT');
  if (input.length > MAX_BYTES) throw new ImageVariantsError('INPUT_TOO_LARGE');
  if (
    typeof profile !== 'string' ||
    !Object.hasOwn(IMAGE_VARIANT_PROFILES, profile)
  )
    throw new ImageVariantsError('INVALID_PROFILE');

  // Snapshot the bounded input before the first await so caller mutations
  // cannot change the validated bytes between decode and encoding.
  const source = Buffer.from(input);
  const format = inputFormat(source);
  if (format === 'png') assertStaticPng(source);

  const image = sharp(source, {
    limitInputPixels: MAX_PIXELS,
    limitInputChannels: 4,
    failOn: 'warning',
    sequentialRead: true,
    unlimited: false,
  });
  let metadata: Metadata;
  let hasTransparency: boolean;
  try {
    metadata = await image.metadata();
    if (metadata.format !== format)
      throw new ImageVariantsError('UNSUPPORTED_FORMAT');
    if (
      (metadata.pages ?? 1) !== 1 ||
      metadata.loop !== undefined ||
      metadata.delay !== undefined
    )
      throw new ImageVariantsError('ANIMATED_IMAGE');
    if (
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) ||
      metadata.width <= 0 ||
      metadata.height <= 0 ||
      metadata.width > MAX_EDGE ||
      metadata.height > MAX_EDGE ||
      metadata.width * metadata.height > MAX_PIXELS
    )
      throw new ImageVariantsError('INVALID_DIMENSIONS');
    // Force a full decode before resize/shrink-on-load can hide corrupt pixels.
    // stats avoids allocating a full-resolution raw output Buffer in Node.
    const stats = await image.clone().stats();
    hasTransparency = metadata.hasAlpha && !stats.isOpaque;
  } catch (error) {
    if (error instanceof ImageVariantsError) throw error;
    throw new ImageVariantsError('INVALID_IMAGE');
  }

  const { width, height } = metadata.autoOrient;
  const variants: ImageVariant[] = [];
  try {
    // Deliberately sequential: no concurrent full-resolution decoders per job.
    for (const size of IMAGE_VARIANT_SIZES) {
      const previous = variants.at(-1);
      if (previous && previous.width === width && previous.height === height) {
        previous.sizes.push(size);
        continue;
      }
      const { data, info } = await image
        .clone()
        .rotate()
        .toColourspace('srgb')
        .resize({
          width: size,
          height: size,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp(IMAGE_VARIANT_PROFILES[profile])
        .timeout({ seconds: 10 })
        .toBuffer({ resolveWithObject: true });
      if (
        info.format !== 'webp' ||
        info.width <= 0 ||
        info.height <= 0 ||
        info.width > Math.min(size, width) ||
        info.height > Math.min(size, height) ||
        !data.length ||
        data.length > MAX_OUTPUT_BYTES
      )
        throw new ImageVariantsError('PROCESSING_FAILED');

      const output = sharp(data, {
        limitInputPixels: 640 * 640,
        limitInputChannels: 4,
        failOn: 'warning',
      });
      const verified = await output.metadata();
      if (
        verified.format !== 'webp' ||
        (verified.pages ?? 1) !== 1 ||
        verified.width !== info.width ||
        verified.height !== info.height ||
        (hasTransparency && !verified.hasAlpha)
      )
        throw new ImageVariantsError('PROCESSING_FAILED');
      await output.stats();
      variants.push({
        sizes: [size],
        buffer: data,
        width: info.width,
        height: info.height,
        bytes: data.length,
        sha256: hash(data),
      });
    }
  } catch (error) {
    if (error instanceof ImageVariantsError) throw error;
    throw new ImageVariantsError('PROCESSING_FAILED');
  }

  return {
    profile,
    source: {
      format,
      width,
      height,
      bytes: source.length,
      sha256: hash(source),
    },
    variants,
  };
}
