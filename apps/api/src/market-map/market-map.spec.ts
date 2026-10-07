import { NotFoundException } from '@nestjs/common';
import { MarketMapService } from './market-map.service.js';
import { floorQuery, pointPatch, pointSchema } from './schema.js';
import type { DbService } from '../db/db.service.js';

const input = { name: 'Fresh Bar', slug: 'fresh-bar', kind: 'FOODCOURT' as const, mapX: 33, mapY: 70 };

describe('Market map validation and publication', () => {
  it('allows an empty unit number, uses draft defaults and validates a future floor', () => {
    expect(pointSchema.parse(input)).toMatchObject({ floor: 2, isPublished: false, sortOrder: 0 });
    expect(pointSchema.parse({ ...input, unitNumber: '  Д1 ' }).unitNumber).toBe('Д1');
    expect(pointSchema.parse({ ...input, unitNumber: '' }).unitNumber).toBe('');
    expect(floorQuery.parse({})).toEqual({ floor: 2 });
    expect(floorQuery.parse({ floor: '3' })).toEqual({ floor: 3 });
  });

  it.each([
    { mapX: -1 }, { mapY: 100.01 }, { mapX: Infinity }, { mapY: NaN },
    { slug: '../private' }, { kind: 'ADMIN' }, { floor: 0 }, { floor: 21 },
    { unitNumber: 'x'.repeat(41) }, { name: ' ' }, { sortOrder: .5 },
    { photoUrl: '/uploads/products/arbitrary.webp' }, { id: 1 },
  ])('rejects invalid or server-owned fields: %o', patch => {
    expect(pointSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(pointPatch.safeParse(patch).success).toBe(false);
  });

  it('rejects an empty patch, but allows publishing without resetting existing fields', () => {
    expect(pointPatch.safeParse({}).success).toBe(false);
    expect(pointPatch.parse({ isPublished: true })).toEqual({ isPublished: true });
  });

  it('accepts ENTRY and rejects the obsolete entrance interpretation', () => {
    expect(pointSchema.parse({ ...input, kind: 'ENTRY' }).kind).toBe('ENTRY');
    expect(pointSchema.safeParse({ ...input, kind: 'ENTRANCE' }).success).toBe(false);
  });

  function fixture() {
    const point = { ...pointSchema.parse(input), id: 7, unitNumber: null, photoUrl: null };
    const db = { $queryRaw: vi.fn(), $transaction: vi.fn(), marketPoint: {
      findMany: vi.fn().mockResolvedValue([point]), findFirst: vi.fn().mockResolvedValue(point),
      findUnique: vi.fn().mockResolvedValue(point), create: vi.fn().mockResolvedValue(point),
      update: vi.fn().mockResolvedValue(point),
    } };
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
    return { db, point, service: new MarketMapService(db as unknown as DbService) };
  }

  it('uses one bounded query for a published floor with deterministic order', async () => {
    const { service, db } = fixture();
    await service.list(2, true);
    expect(db.marketPoint.findMany).toHaveBeenCalledWith({ where: { floor: 2, isPublished: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 500 });
    await service.list(2);
    expect(db.marketPoint.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { floor: 2 } }));
  });

  it('does not expose hidden details and returns 404 for an absent point', async () => {
    const { service, db } = fixture();
    await service.publicPoint('fresh-bar');
    expect(db.marketPoint.findFirst).toHaveBeenCalledWith({ where: { slug: 'fresh-bar', isPublished: true } });
    db.marketPoint.findFirst.mockResolvedValue(null);
    await expect(service.publicPoint('fresh-bar')).rejects.toBeInstanceOf(NotFoundException);
    db.marketPoint.findUnique.mockResolvedValue(null);
    await expect(service.get(7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes optional blank text and preserves unspecified fields in a patch', async () => {
    const { service, db } = fixture();
    await service.create(pointSchema.parse({ ...input, unitNumber: ' ', description: '', sampleAssortment: '  Соки  ' }));
    expect(db.marketPoint.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      unitNumber: null, description: null, sampleAssortment: 'Соки',
    }) });
    await service.update(7, { isPublished: true });
    expect(db.marketPoint.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { isPublished: true } });
  });

  it('maps a duplicate slug and an absent update to safe HTTP errors', async () => {
    const { service, db } = fixture();
    db.marketPoint.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create(pointSchema.parse(input))).rejects.toMatchObject({ status: 409 });
    db.marketPoint.update.mockRejectedValue({ code: 'P2025' });
    await expect(service.update(7, { name: 'Другое' })).rejects.toMatchObject({ status: 404 });
  });

  it('validates partial position updates against the existing coordinate pair before writing', async () => {
    const { service, db, point } = fixture();
    await expect(service.update(7, { mapX: null })).rejects.toMatchObject({ status: 400 });
    expect(db.marketPoint.update).not.toHaveBeenCalled();
    db.marketPoint.findUnique.mockResolvedValue({ ...point, mapX: null, mapY: null });
    await expect(service.update(7, { mapX: 20 })).rejects.toMatchObject({ status: 400 });
    expect(db.marketPoint.update).not.toHaveBeenCalled();
    await service.update(7, { mapX: 20, mapY: 30 });
    expect(db.marketPoint.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { mapX: 20, mapY: 30 } });
    await service.update(7, { mapX: null, mapY: null });
    expect(db.marketPoint.update).toHaveBeenLastCalledWith({ where: { id: 7 }, data: { mapX: null, mapY: null } });
  });
});
