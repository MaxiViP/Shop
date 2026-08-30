import 'dotenv/config';
import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './gen/client.js';

@Injectable()
export class DbService extends PrismaClient {
  constructor() {
    const url = process.env.DATABASE_URL;

    if (!url) throw new Error('DATABASE_URL is not set');

    super({
      adapter: new PrismaPg({ connectionString: url }),
    });
  }
}
