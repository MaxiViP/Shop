import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { SeasonAssignment, SeasonInput } from './seasons.schema.js';
import type { Prisma } from '../db/gen/client.js';
import { fillSeasonPresets, seasonPresets } from './season-presets.js';

@Injectable()
export class SeasonsService {
  constructor(private readonly db: DbService) {}
  list() {
    return this.db.seasonTemplate.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { products: true } } } });
  }
  private async lock(db: Prisma.TransactionClient) {
    await db.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(61893423)`;
  }
  catalog() { return seasonPresets; }
  presets() {
    return this.db.$transaction(async db => { await this.lock(db); return fillSeasonPresets(db); });
  }
  create(data: SeasonInput) {
    return this.db.$transaction(async db => { await this.lock(db); return db.seasonTemplate.create({ data }); });
  }
  update(id: number, data: Partial<SeasonInput>) {
    return this.db.$transaction(async db => {
      await this.lock(db);
      if (!await db.seasonTemplate.findUnique({ where: { id } })) throw new NotFoundException('Шаблон не найден');
      return db.seasonTemplate.update({ where: { id }, data });
    });
  }
  assign(data: SeasonAssignment) {
    return this.db.$transaction(async db => {
      if (data.seasonTemplateId !== null && !await db.seasonTemplate.findUnique({ where: { id: data.seasonTemplateId } }))
        throw new NotFoundException('Шаблон не найден');
      if (await db.product.count({ where: { id: { in: data.ids } } }) !== data.ids.length)
        throw new ConflictException('Список товаров изменился. Обновите страницу.');
      const result = await db.product.updateMany({ where: { id: { in: data.ids } }, data: {
        seasonalMode: data.seasonalMode, seasonTemplateId: data.seasonTemplateId,
        isSeasonal: data.seasonalMode === 'MANUAL', seasonalStartsAt: null, seasonalEndsAt: null,
      } });
      if (result.count !== data.ids.length)
        throw new ConflictException('Список товаров изменился. Обновите страницу.');
      return { count: result.count };
    });
  }
}
