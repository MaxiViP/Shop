import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { DbService } from '../db/db.service.js';
import { dbError } from '../admin/errors.js';
import { managedPath } from '../admin/images.service.js';
import { normalizeImage, productUploadRoot, type ImageFile } from '../common/image.js';
import { escalatorSchema, pointSchema, type LayoutInput, type PointInput, type PointPatch } from './schema.js';
import { Prisma } from '../db/gen/client.js';

function optionalText<T extends Partial<PointInput>>(data: T): T {
  return {
    ...data,
    ...Object.fromEntries(['unitNumber', 'description', 'sampleAssortment', 'ourLabel'].flatMap(key => {
      const value = data[key as 'unitNumber' | 'description' | 'sampleAssortment' | 'ourLabel'];
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
    try {
      return await this.db.$transaction(async db => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(13690180)`;
        if (data.isOurPoint) await db.marketPoint.updateMany({ where: { floor: data.floor, isOurPoint: true }, data: { isOurPoint: false } });
        return db.marketPoint.create({ data: optionalText(data) });
      });
    }
    catch (error) { return dbError(error); }
  }

  async update(id: number, data: PointPatch) {
    try {
      return await this.db.$transaction(async db => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(13690180)`;
        await db.$queryRaw`SELECT id FROM "MarketPoint" WHERE id = ${id} FOR UPDATE`;
        const current = await db.marketPoint.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('Точка не найдена');
        const { expectedUpdatedAt, ...changes } = data;
        if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt)
          throw new ConflictException('Точка изменена другим администратором. Обновите данные перед сохранением.');
        const checked = pointSchema.strip().safeParse({ ...current, ...changes });
        if (!checked.success) throw new BadRequestException(checked.error.issues[0]?.message);
        if (checked.data.isOurPoint) await db.marketPoint.updateMany({
          where: { floor: checked.data.floor, isOurPoint: true, id: { not: id } }, data: { isOurPoint: false },
        });
        return db.marketPoint.update({ where: { id }, data: optionalText(changes) });
      });
    }
    catch (error) { return dbError(error); }
  }

  async layout(floor: number, publishedOnly = false) {
    const row = await this.db.marketLayout.findUnique({ where: { floor } });
    const parsed = escalatorSchema.safeParse(row?.escalator);
    const escalator = parsed.success && (!publishedOnly || parsed.data.published) ? parsed.data : null;
    return { floor, escalator, updatedAt: row?.updatedAt ?? null };
  }

  async floors() {
    const [points, layouts] = await Promise.all([
      this.db.marketPoint.groupBy({ by: ['floor'], where: { isPublished: true } }),
      this.db.marketLayout.findMany({ orderBy: { floor: 'asc' } }),
    ]);
    return [...new Set([2, ...points.map(point => point.floor), ...layouts.filter(row => {
      const parsed = escalatorSchema.safeParse(row.escalator); return parsed.success && parsed.data.published;
    }).map(row => row.floor)])].sort((a, b) => a - b);
  }

  async saveLayout(floor: number, data: LayoutInput) {
    return this.db.$transaction(async db => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(13690180)`;
      const current = await db.marketLayout.findUnique({ where: { floor } });
      if (data.expectedUpdatedAt !== undefined && (current?.updatedAt.toISOString() ?? null) !== data.expectedUpdatedAt)
        throw new ConflictException('Схема изменена другим администратором. Обновите данные.');
      const escalator = data.escalator === null ? Prisma.DbNull : data.escalator;
      const row = await db.marketLayout.upsert({ where: { floor }, create: { floor, escalator }, update: { escalator } });
      return { floor, escalator: data.escalator, updatedAt: row.updatedAt };
    });
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
