import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

@Controller('health')
export class HealthCtrl {
  constructor(private readonly db: DbService) {}

  @Get()
  check() { return { ok: true }; }

  @Get('ready')
  async ready() {
    try {
      // Validate the schema this release actually reads, not only an open socket.
      await this.db.$queryRaw`SELECT "normalizedPrice" FROM "Product" LIMIT 1`;
      await this.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
      return { ok: true, database: true };
    } catch {
      throw new ServiceUnavailableException({ ok: false, database: false });
    }
  }
}
