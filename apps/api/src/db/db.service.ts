import 'dotenv/config';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ActivityPrismaPg } from '../admin/activity-context.js';
import { PrismaClient } from './gen/client.js';

@Injectable()
export class DbService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL;

    if (!url) throw new Error('DATABASE_URL is not set');

    super({
      adapter: new ActivityPrismaPg({ connectionString: url }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
