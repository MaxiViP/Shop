import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService) {}
  get() {
    return this.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
  }
  update(weightToleranceBps: number, updatedById: number, customerResponseMinutes?: number) {
    return this.db.shopSettings.update({
      where: { id: 1 },
      data: { weightToleranceBps, updatedById, customerResponseMinutes },
    });
  }
}
