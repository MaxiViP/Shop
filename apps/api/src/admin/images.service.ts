import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { DbService } from '../db/db.service.js';
import { dbError } from './errors.js';
import type { ImageInput } from './schema.js';

export const uploadRoot = resolve(process.env.UPLOAD_DIR || 'uploads/products');
export interface ImageFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}
export function managedPath(url: string): string | null {
  const match = /^\/uploads\/products\/([a-f0-9-]{36}\.webp)$/.exec(url);
  return match ? resolve(uploadRoot, match[1]!) : null;
}

@Injectable()
export class ImagesService {
  constructor(private readonly db: DbService) {}

  async upload(productId: number, file?: ImageFile) {
    if (
      !file ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    )
      throw new BadRequestException('Разрешены только JPEG, PNG и WebP');
    if (file.size > 5 * 1024 * 1024)
      throw new BadRequestException('Максимальный размер фото — 5 МБ');
    let buffer: Buffer;
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
      buffer = await image.rotate().webp({ quality: 85 }).toBuffer();
    } catch {
      throw new BadRequestException(
        'Файл не является корректным JPEG, PNG или WebP (до 25 мегапикселей)',
      );
    }
    const url = `/uploads/products/${randomUUID()}.webp`;
    const path = managedPath(url)!;
    await mkdir(uploadRoot, { recursive: true });
    await writeFile(path, buffer, { flag: 'wx' });
    try {
      return await this.db.$transaction(async (db) => {
        await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
        if (!(await db.product.findUnique({ where: { id: productId } })))
          throw new NotFoundException('Товар не найден');
        const images = await db.productImage.findMany({
          where: { productId },
          select: { sort: true },
        });
        if (images.length >= 8)
          throw new ConflictException('Можно загрузить не более 8 фотографий');
        return db.productImage.create({
          data: {
            productId,
            url,
            sort: Math.max(-1, ...images.map((image) => image.sort)) + 1,
          },
        });
      });
    } catch (error) {
      await unlink(path);
      return dbError(error);
    }
  }

  async update(productId: number, id: number, data: ImageInput) {
    try {
      return await this.db.$transaction(async (db) => {
        await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
        const images = await db.productImage.findMany({
          where: { productId },
          orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        });
        if (!images.some((image) => image.id === id))
          throw new NotFoundException('Фото не найдено');
        if (
          data.visible === false &&
          images.find((image) => image.visible)?.id === id
        )
          throw new ConflictException(
            'Сначала выберите другую основную фотографию',
          );
        return db.productImage.update({ where: { id, productId }, data });
      });
    } catch (error) {
      return dbError(error);
    }
  }

  async primary(productId: number, id: number) {
    try {
      return await this.db.$transaction(async (db) => {
        await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
        const images = await db.productImage.findMany({
          where: { productId },
          orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        });
        const selected = images.find((image) => image.id === id);
        if (!selected) throw new NotFoundException('Фото не найдено');
        const ordered = [
          selected,
          ...images.filter((image) => image.id !== id),
        ];
        for (const [sort, image] of ordered.entries())
          await db.productImage.update({
            where: { id: image.id, productId },
            data: { sort, ...(image.id === id ? { visible: true } : {}) },
          });
        return db.productImage.findMany({
          where: { productId },
          orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        });
      });
    } catch (error) {
      return dbError(error);
    }
  }

  async remove(productId: number, id: number) {
    let image;
    try {
      image = await this.db.$transaction(async (db) => {
        await db.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
        return db.productImage.delete({ where: { id, productId } });
      });
    } catch (error) {
      return dbError(error);
    }
    await this.cleanup(image.url);
    return { ok: true };
  }

  async cleanup(url: string) {
    const path = managedPath(url);
    if (!path) return;
    // Keep assets referenced by historical order snapshots or another image.
    if (
      (await this.db.orderItem.count({ where: { image: url } })) ||
      (await this.db.productImage.count({ where: { url } }))
    )
      return;
    try {
      await unlink(path);
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
}
