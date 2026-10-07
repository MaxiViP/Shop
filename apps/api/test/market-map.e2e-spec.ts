import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { MarketMapModule } from '../src/market-map/market-map.module.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { managedPath } from '../src/admin/images.service.js';

interface Point { id: number; slug: string; isPublished: boolean; unitNumber: string | null; photoUrl: string | null }

describe.skipIf(!process.env.DATABASE_URL)('Market map / local PostgreSQL', () => {
  const schema = `market_map_test_${randomUUID().replaceAll('-', '')}`;
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>, png: Buffer;
  let created = false;
  const uploaded = new Set<string>();
  const input = { name: 'Тестовый Fresh Bar', slug: 'test-fresh-bar', kind: 'FOODCOURT',
    mapX: 33.08, mapY: 70.14, description: 'Прилавок', sampleAssortment: 'Соки' };
  const admin = () => request(app.getHttpServer());

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local test database required');
    vi.stubEnv('ADMIN_PHONE', '+79990000888');
    connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    if (!/^market_map_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('prisma/migrations');
    for (const entry of (await readdir(migrations, { withFileTypes: true }))
      .filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}` }, { schema }) });
    const module = await Test.createTestingModule({ imports: [MarketMapModule] })
      .overrideProvider(DbService).useValue(db)
      .overrideProvider(AuthService).useValue({ me: async (token: string) =>
        ['USER', 'SELLER', 'ADMIN'].includes(token) ? { id: 1, role: token, phone: '+79990000888' } : null,
      }).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true })); await app.init();
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#22aa77' } }).png().toBuffer();
  }, 60000);

  afterAll(async () => {
    for (const url of uploaded) {
      const path = managedPath(url);
      if (path) {
        const { unlink } = await import('node:fs/promises');
        await unlink(path).catch(() => {});
      }
    }
    await app?.close(); await db?.$disconnect();
    if (created && /^market_map_test_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end(); vi.unstubAllEnvs();
  });

  it('migrates reference data with empty numbers/photos and real relative positions', async () => {
    const seeded = await db.marketPoint.findMany();
    expect(seeded).toHaveLength(60);
    expect(seeded.filter(point => point.kind !== 'ENTRY')).toHaveLength(58);
    expect(new Set(seeded.map(point => point.slug)).size).toBe(60);
    expect(new Set(seeded.map(point => point.name.trim().toLocaleLowerCase('ru-RU'))).size).toBe(60);
    expect(seeded.every(point => point.unitNumber === null && point.photoUrl === null
      && point.isPublished && point.floor === 2)).toBe(true);
    const bar = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'fresh-bar' } });
    const batumi = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'batumi' } });
    expect(bar).toMatchObject({ floor: 2, unitNumber: null, photoUrl: null, isPublished: true });
    expect(bar.mapY).toBeGreaterThan(batumi.mapY);
    const publicPoints = (await admin().get('/api/market-map').expect(200)).body;
    expect(publicPoints).toHaveLength(60);
    expect(publicPoints.filter((row: { kind: string }) => row.kind === 'ENTRY')).toHaveLength(2);
    expect(await db.marketPoint.findUniqueOrThrow({ where: { slug: 'beri-zaryad' } })).toMatchObject({ kind: 'SERVICE' });
    expect((await admin().get('/api/market-map?floor=3').expect(200)).body).toEqual([]);
  });

  it('places exactly two entries at the owner-specified interior landmarks', async () => {
    const entries = await db.marketPoint.findMany({ where: { kind: 'ENTRY' }, orderBy: { sortOrder: 'asc' } });
    expect(entries.map(point => point.slug)).toEqual(['entry-butterbrot', 'entry-stairs']);
    const butter = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'butterbrot' } });
    const sausages = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'belarusian-sausages' } });
    const georgia = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'gifts-georgia' } });
    const gornitsa = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'gornitsa' } });
    const pickles = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'pickles-sweets' } });
    expect(entries[0]!.mapX).toBeLessThan(butter.mapX);
    expect(entries[0]!.mapY).toBeGreaterThan(butter.mapY);
    expect(entries[0]!.mapY).toBeLessThan(sausages.mapY);
    expect(entries[1]!.mapX).toBeGreaterThan(gornitsa.mapX);
    expect(entries[1]!.mapX).toBeLessThan(pickles.mapX);
    expect(entries[1]!.mapY).toBeGreaterThan(georgia.mapY);
    expect(entries[1]!.mapY).toBeLessThan(gornitsa.mapY);
    expect(await db.marketPoint.count({ where: { slug: { startsWith: 'entrance-' } } })).toBe(0);
  });

  it.each(['USER', 'SELLER', 'missing'])('blocks every editing route for %s', async role => {
    const cookie = `${SID}=${role}`;
    await admin().get('/api/admin/market-map/points').set('Cookie', cookie).expect(403);
    await admin().get('/api/admin/market-map/points/1').set('Cookie', cookie).expect(403);
    await admin().post('/api/admin/market-map/points').set('Cookie', cookie).send(input).expect(403);
    await admin().patch('/api/admin/market-map/points/1').set('Cookie', cookie).send({ name: 'x' }).expect(403);
    await admin().post('/api/admin/market-map/points/1/photo').set('Cookie', cookie).attach('file', png, 'test.png').expect(403);
    await admin().delete('/api/admin/market-map/points/1/photo').set('Cookie', cookie).expect(403);
  });

  it('creates a draft, edits fields, publishes/hides it and supports optional numbers', async () => {
    const result = await admin().post('/api/admin/market-map/points').set('Cookie', `${SID}=ADMIN`).send(input).expect(201);
    const point = result.body as Point;
    expect(point).toMatchObject({ unitNumber: null, isPublished: false });
    await admin().get('/api/market-map/test-fresh-bar').expect(404);
    const changed = await admin().patch(`/api/admin/market-map/points/${point.id}`).set('Cookie', `${SID}=ADMIN`)
      .send({ unitNumber: ' Д1 ', name: 'Fresh Bar тест', description: 'Новое описание',
        sampleAssortment: 'Соки и фреш', mapX: 45.5, mapY: 62, sortOrder: -1, isPublished: true }).expect(200);
    expect(changed.body).toMatchObject({ unitNumber: 'Д1', mapX: 45.5, mapY: 62 });
    await admin().get('/api/market-map/test-fresh-bar').expect(200);
    const points = (await admin().get('/api/market-map').expect(200)).body as Point[];
    expect(points[0]?.id).toBe(point.id);
    expect(points.filter(row => row.id === point.id)).toHaveLength(1);
    await admin().patch(`/api/admin/market-map/points/${point.id}`).set('Cookie', `${SID}=ADMIN`)
      .send({ unitNumber: '', isPublished: false }).expect(200);
    expect((await admin().get(`/api/admin/market-map/points/${point.id}`).set('Cookie', `${SID}=ADMIN`).expect(200)).body.unitNumber).toBeNull();
    await admin().get('/api/market-map/test-fresh-bar').expect(404);
    expect((await admin().get('/api/market-map').expect(200)).body.some((row: Point) => row.id === point.id)).toBe(false);
  });

  it('rejects invalid requests, unsafe photo URLs, duplicate slugs, bad origin and unknown points', async () => {
    for (const patch of [{ mapX: -1 }, { mapY: 101 }, { photoUrl: 'https://example.org/x' }, { floor: 0 }, {}])
      await admin().patch('/api/admin/market-map/points/1').set('Cookie', `${SID}=ADMIN`).send(patch).expect(400);
    await admin().post('/api/admin/market-map/points').set('Cookie', `${SID}=ADMIN`).send({ ...input, slug: 'fresh-bar' }).expect(409);
    await admin().post('/api/admin/market-map/points').set('Cookie', `${SID}=ADMIN`).set('Origin', 'https://foreign.invalid').send(input).expect(403);
    await admin().get('/api/market-map/unknown-market-point').expect(404);
    await admin().get('/api/market-map?floor=0').expect(400);
    await admin().patch('/api/admin/market-map/points/2147483647').set('Cookie', `${SID}=ADMIN`).send({ name: 'x' }).expect(404);
  });

  it('allows ADMIN to edit, hide, move and photograph an ENTRY while preserving its floor', async () => {
    const point = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'entry-butterbrot' } });
    const cookie = `${SID}=ADMIN`;
    const changed = await admin().patch(`/api/admin/market-map/points/${point.id}`).set('Cookie', cookie)
      .send({ name: 'Вход на 2 этаж · уточнённый', unitNumber: ' А1 ', kind: 'ENTRY', description: 'Лестница',
        sampleAssortment: null, mapX: 42, mapY: 53, isPublished: false }).expect(200);
    expect(changed.body).toMatchObject({ floor: 2, kind: 'ENTRY', unitNumber: 'А1', mapX: 42, mapY: 53, isPublished: false });
    await admin().get('/api/market-map/entry-butterbrot').expect(404);
    const photographed = await admin().post(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', cookie)
      .attach('file', png, { filename: 'entry.png', contentType: 'image/png' }).expect(201);
    uploaded.add((photographed.body as Point).photoUrl!);
    expect(photographed.body).toMatchObject({ floor: 2, kind: 'ENTRY', mapX: 42, mapY: 53 });
    await admin().delete(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', cookie).expect(200);
    await admin().patch(`/api/admin/market-map/points/${point.id}`).set('Cookie', cookie)
      .send({ name: point.name, unitNumber: null, description: point.description,
        mapX: point.mapX, mapY: point.mapY, isPublished: true }).expect(200);
    expect((await admin().get('/api/market-map/entry-butterbrot').expect(200)).body)
      .toMatchObject({ floor: 2, kind: 'ENTRY', unitNumber: null, isPublished: true });
  });

  it('normalizes a cover, replaces and removes its file without losing text or placement', async () => {
    const point = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'fresh-bar' } });
    let previous: string | null = null;
    for (let i = 0; i < 2; i++) {
      const updated = await admin().post(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', `${SID}=ADMIN`)
        .attach('file', png, { filename: 'cover.png', contentType: 'image/png' }).expect(201);
      const photoUrl = (updated.body as Point).photoUrl!; uploaded.add(photoUrl);
      expect(photoUrl).toMatch(/^\/uploads\/products\/[a-f0-9-]{36}\.webp$/);
      expect((await sharp(await readFile(managedPath(photoUrl)!)).metadata()).format).toBe('webp');
      expect(updated.body).toMatchObject({ name: point.name, mapX: point.mapX, mapY: point.mapY });
      if (previous) await expect(readFile(managedPath(previous)!)).rejects.toMatchObject({ code: 'ENOENT' });
      previous = photoUrl;
    }
    expect((await admin().get('/api/market-map/fresh-bar').expect(200)).body.photoUrl).toBe(previous);
    await admin().delete(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', `${SID}=ADMIN`).expect(200);
    await expect(readFile(managedPath(previous!)!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await db.marketPoint.findUniqueOrThrow({ where: { id: point.id } })).photoUrl).toBeNull();
  });

  it('rejects oversized and spoofed uploads while keeping the previous cover', async () => {
    const point = await db.marketPoint.findUniqueOrThrow({ where: { slug: 'fresh-bar' } });
    await admin().post(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', `${SID}=ADMIN`)
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' }).expect(413);
    await admin().post(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', `${SID}=ADMIN`)
      .attach('file', Buffer.from('<svg>bad</svg>'), { filename: 'bad.png', contentType: 'image/png' }).expect(400);
    await admin().post(`/api/admin/market-map/points/${point.id}/photo`).set('Cookie', `${SID}=ADMIN`).expect(400);
    expect((await db.marketPoint.findUniqueOrThrow({ where: { id: point.id } })).photoUrl).toBeNull();
  });

  it('keeps database constraints and the index consistent with the Prisma model', async () => {
    for (const [field, value] of [['mapX', -1], ['mapY', 101], ['floor', 0]] as const)
      await expect(connection.query(`UPDATE "MarketPoint" SET "${field}" = $1 WHERE "slug" = 'fresh-bar'`, [value]))
        .rejects.toMatchObject({ code: '23514' });
    const index = await connection.query<{ indexdef: string }>(
      'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
      [schema, 'MarketPoint_floor_isPublished_sortOrder_id_idx'],
    );
    expect(index.rows[0]?.indexdef.replaceAll('"', '')).toContain('(floor, isPublished, sortOrder, id)');
  });

  it('keeps unlocated points editable and rejects incomplete coordinate patches with 400', async () => {
    const createdPoint = await admin().post('/api/admin/market-map/points').set('Cookie', `${SID}=ADMIN`)
      .send({ ...input, slug: 'unlocated-patch-test', mapX: null, mapY: null }).expect(201);
    const id = createdPoint.body.id as number;
    await admin().patch(`/api/admin/market-map/points/${id}`).set('Cookie', `${SID}=ADMIN`).send({ mapX: 20 }).expect(400);
    expect(await db.marketPoint.findUniqueOrThrow({ where: { id } })).toMatchObject({ mapX: null, mapY: null });
    await admin().patch(`/api/admin/market-map/points/${id}`).set('Cookie', `${SID}=ADMIN`).send({ mapX: 20, mapY: 30 }).expect(200);
    await admin().patch(`/api/admin/market-map/points/${id}`).set('Cookie', `${SID}=ADMIN`).send({ mapY: null }).expect(400);
    await admin().patch(`/api/admin/market-map/points/${id}`).set('Cookie', `${SID}=ADMIN`).send({ mapX: null, mapY: null }).expect(200);
    expect(await db.marketPoint.findUniqueOrThrow({ where: { id } })).toMatchObject({ mapX: null, mapY: null });
  });
});
