import { BadRequestException } from '@nestjs/common';
import { resolve } from 'node:path';
import sharp from 'sharp';

export const productUploadRoot = resolve(
  process.env.UPLOAD_DIR || 'uploads/products',
);

export interface ImageFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export async function normalizeImage(file?: ImageFile, preserveWebp = false, maxWidth?: number): Promise<Buffer> {
  if (
    !file ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
  )
    throw new BadRequestException('Разрешены только JPEG, PNG и WebP');
  if (file.size > 5 * 1024 * 1024 || file.buffer.length > 5 * 1024 * 1024)
    throw new BadRequestException('Максимальный размер фото — 5 МБ');
  try {
    const image = sharp(file.buffer, {
      limitInputPixels: 25_000_000,
      failOn: 'warning',
    });
    const info = await image.metadata();
    const formats: Record<string, string> = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    if (
      !info.format ||
      formats[info.format] !== file.mimetype ||
      (info.pages ?? 1) > 1
    )
      throw new Error('format');
    if (preserveWebp && info.format === 'webp') {
      await image.clone().raw().toBuffer();
      return file.buffer;
    }
    return await image.rotate().resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw new BadRequestException(
      'Файл не является корректным JPEG, PNG или WebP (до 25 мегапикселей)',
    );
  }
}
