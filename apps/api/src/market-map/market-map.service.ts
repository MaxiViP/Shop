import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { DbService } from '../db/db.service.js';
import { dbError } from '../admin/errors.js';
import { managedPath } from '../admin/images.service.js';
import { normalizeImage, productUploadRoot, type ImageFile } from '../common/image.js';
import type { PointInput } from './schema.js';

function optionalText<T extends Partial<PointInput>>(data: T): T {
  return {
    ...data,
    ...Object.fromEntries(['unitNumber', 'description', 'sampleAssortment'].flatMap(key => {
      const value = data[key as 'unitNumber' | 'description' | 'sampleAssortment'];
      return value === undefined ? [] : [[key, value?.trim() || null]];
    })),
  };
}

@Injectable()
export class MarketMapService {
  private readonly logger = new Logger(MarketMapService.name);
  constructor(private readonly db: DbService) {}

  list(floor: number, publishedOnly = false) {
    return this.db.marketPoint.findMany({
      where: { floor, ...(publishedOnly ? { isPublished: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: 500,
    });
  }

  async publicPoint(slug: string) {
    const point = await this.db.marketPoint.findFirst({ where: { slug, isPublished: true } });
    if (!point) throw new NotFoundException('Точка не найдена');
    return point;
  }

  async get(id: number) {
    const point = await this.db.marketPoint.findUnique({ where: { id } });
    if (!point) throw new NotFoundException('Точка не найдена');
    return point;
  }

  async create(data: PointInput) {
    try { return await this.db.marketPoint.create({ data: optionalText(data) }); }
    catch (error) { return dbError(error); }
  }

  async update(id: number, data: Partial<PointInput>) {
    try { return await this.db.marketPoint.update({ where: { id }, data: optionalText(data) }); }
    catch (error) { return dbError(error); }
  }

  async upload(id: number, file?: ImageFile) {
    await this.get(id);
    const buffer = await normalizeImage(file);
    const photoUrl = `/uploads/products/${randomUUID()}.webp`;
    const path = managedPath(photoUrl)!;
    await mkdir(productUploadRoot, { recursive: true });
    await writeFile(path, buffer, { flag: 'wx' });
    try { return await this.setPhoto(id, photoUrl); }
    catch (error) { await this.cleanup(photoUrl); throw error; }
  }

  removePhoto(id: number) { return this.setPhoto(id, null); }

  private async setPhoto(id: number, photoUrl: string | null) {
    const result = await this.db.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM "MarketPoint" WHERE id = ${id} FOR UPDATE`;
      const current = await db.marketPoint.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Точка не найдена');
      const point = await db.marketPoint.update({ where: { id }, data: { photoUrl } });
      return { point, previousUrl: current.photoUrl };
    });
    if (result.previousUrl) await this.cleanup(result.previousUrl);
    return result.point;
  }

  private async cleanup(url: string) {
    const path = managedPath(url);
    if (!path) return;
    try { await unlink(path); }
    catch (error) {
      if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT'))
        this.logger.warn('Не удалось удалить прежнее фото точки рынка');
    }
  }
}
