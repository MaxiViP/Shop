import { BadRequestException, Injectable } from '@nestjs/common';
import type { SettingsInput } from './settings.schema.js';
import { DbService } from '../db/db.service.js';
@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService) {}
  get() {
    return this.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
  }
  update(input: SettingsInput, updatedById: number) {
    return this.db.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
      const current = await db.shopSettings.findUniqueOrThrow({
        where: { id: 1 },
      });
      const next = { ...current, ...input };
      if (!next.deliveryEnabled && !next.pickupEnabled)
        throw new BadRequestException(
          'Должен быть доступен хотя бы один способ получения заказа.',
        );
      if (next.maxOrderExtrasTotal < next.maxOrderExtraUnitPrice)
        throw new BadRequestException(
          'Общий лимит услуг не может быть меньше лимита цены одной услуги.',
        );
      return db.shopSettings.update({
        where: { id: 1 },
        data: { ...input, updatedById },
      });
    });
  }
}
