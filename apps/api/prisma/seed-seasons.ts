import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { fillSeasonPresets } from '../src/admin/season-presets.js';

const value = process.env.DATABASE_URL;
if (!value) throw new Error('DATABASE_URL is not set');
const url = new URL(value);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || (url.port || '5432') !== '5432' || url.pathname !== '/shop')
  throw new Error('Season seed requires the local localhost:5432/shop database.');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: value }) });
try {
  const result = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(61893423)`;
    return fillSeasonPresets(tx);
  });
  console.log(JSON.stringify(result));
} finally { await db.$disconnect(); }
