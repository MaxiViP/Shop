import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DbService } from '../db/db.service.js';
import type { HomeSlide, Prisma } from '../db/gen/client.js';
import { normalizeImage, productUploadRoot, type ImageFile } from '../common/image.js';
import { hitWhere, seasonalWhere } from '../product/badges.js';
import { freeDelivery } from '../order/free-delivery.js';
import { slideSchema, type SlideInput } from './slides.schema.js';
import { renderSlide, slideStatus } from './slides.js';

function input(slide: HomeSlide): SlideInput {
  const { type, content, title, text, image, position, eyebrow, buttonLabel, to, active, published, priority, sortOrder } = slide;
  return { type, content, title, text, image, position: slideSchema.shape.position.parse(position), eyebrow, buttonLabel, to, active, published, priority, sortOrder,
    startsAt: slide.startsAt?.toISOString() ?? null, endsAt: slide.endsAt?.toISOString() ?? null };
}

function validate(data: SlideInput) {
  const result = slideSchema.safeParse(data);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}

@Injectable()
export class SlidesService {
  constructor(private readonly db: DbService) {}

  async list() {
    const now = new Date();
    const slides = await this.db.homeSlide.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    return slides.map(slide => ({ ...slide, status: slideStatus(slide, now) }));
  }

  private async conditions(db: Prisma.TransactionClient, now: Date) {
    const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
    const rule = freeDelivery(null, settings);
    const seasonal = await db.product.count({ where: { active: true, category: { active: true }, ...seasonalWhere(now) } });
    const hits = await db.product.count({ where: { active: true, category: { active: true }, AND: hitWhere() } });
    return { freeDeliveryThreshold: rule.threshold, seasonal: seasonal > 0, hits: hits > 0 };
  }

  public() {
    return this.db.$transaction(async db => {
      const now = new Date();
      const slides = await db.homeSlide.findMany({ where: { published: true, active: true },
        orderBy: [{ priority: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }] });
      const conditions = await this.conditions(db, now);
      // Refresh at a schedule boundary, and at least once a minute for settings/product changes.
      const boundaries = slides.flatMap(slide => [slide.startsAt, slide.endsAt]).filter((at): at is Date => !!at && at > now);
      const validUntil = new Date(Math.min(now.getTime() + 60_000, ...boundaries.map(at => at.getTime())));
      return { serverNow: now, validUntil,
        slides: slides.filter(slide => slideStatus(slide, now) === 'ACTIVE').flatMap(slide => {
          const rendered = renderSlide(slide, conditions);
          return rendered ? [rendered] : [];
        }) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async preview(data: SlideInput) {
    validate(data);
    const now = new Date();
    const conditions = await this.conditions(this.db, now);
    const slide = renderSlide({ ...data, id: 0, endsAt: data.endsAt ? new Date(data.endsAt) : null }, conditions);
    return { slide, reason: slide ? null : 'Условие показа не выполнено: проверьте настройки доставки или наличие товаров в подборке.' };
  }

  private async lock(db: Prisma.TransactionClient) {
    await db.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(61893421)`;
  }

  private async prioritize(db: Prisma.TransactionClient, data: SlideInput) {
    if (data.published && data.priority)
      await db.homeSlide.updateMany({ where: { priority: true, published: true }, data: { priority: false } });
  }

  create(data: SlideInput) {
    validate(data);
    return this.db.$transaction(async db => {
      await this.lock(db);
      if (await db.homeSlide.count() >= 40) throw new ConflictException('Можно хранить до 40 слайдов.');
      await this.prioritize(db, data);
      return db.homeSlide.create({ data });
    });
  }

  update(id: number, patch: Partial<SlideInput>) {
    return this.db.$transaction(async db => {
      await this.lock(db);
      const current = await db.homeSlide.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Слайд не найден');
      const data = validate({ ...input(current), ...patch });
      await this.prioritize(db, data);
      return db.homeSlide.update({ where: { id }, data });
    });
  }

  async copy(id: number) {
    const slide = await this.db.homeSlide.findUnique({ where: { id } });
    if (!slide) throw new NotFoundException('Слайд не найден');
    return this.create({ ...input(slide), title: slide.title.slice(0, 132) + ' (копия)', published: false, priority: false,
      sortOrder: Math.min(1_000_000, slide.sortOrder + 1) });
  }

  remove(id: number) {
    return this.db.$transaction(async db => {
      await this.lock(db);
      if (!await db.homeSlide.findUnique({ where: { id } })) throw new NotFoundException('Слайд не найден');
      await db.homeSlide.delete({ where: { id } });
      return { ok: true }; // Images are retained, including those shared by copies.
    });
  }

  reorder(ids: number[]) {
    return this.db.$transaction(async db => {
      await this.lock(db);
      const all = await db.homeSlide.findMany({ select: { id: true } });
      if (all.length !== ids.length || all.some(slide => !ids.includes(slide.id)))
        throw new ConflictException('Список слайдов изменился. Обновите страницу.');
      for (const [sortOrder, id] of ids.entries()) await db.homeSlide.update({ where: { id }, data: { sortOrder } });
      return { ok: true };
    });
  }

  async upload(id: number, file?: ImageFile) {
    if (!await this.db.homeSlide.findUnique({ where: { id } })) throw new NotFoundException('Слайд не найден');
    const buffer = await normalizeImage(file, false, 1920);
    const root = resolve(productUploadRoot, 'hero');
    const name = `${randomUUID()}.webp`;
    const path = resolve(root, name);
    await mkdir(root, { recursive: true });
    await writeFile(path, buffer, { flag: 'wx' });
    // Upload only stages a URL. Publication happens when the editor saves the slide.
    return { image: `/uploads/products/hero/${name}` };
  }
}
