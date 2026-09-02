import { NotFoundException } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DbService } from '../db/db.service.js';
import { FavoriteCtrl } from './favorite.ctrl.js';
import { FavoriteService } from './favorite.service.js';
import { favoriteSyncSchema } from './schema.js';

const product = {
  id: 10,
  name: 'Авокадо',
  slug: 'avocado',
  price: 14_900,
  priceQty: 1,
  unit: 'PIECE' as const,
  step: 1,
  min: 1,
  category: { name: 'Фрукты', slug: 'fruits' },
  images: [],
};

function setup() {
  const favorite = {
    findMany: vi.fn().mockResolvedValue([{ product }]),
    upsert: vi.fn().mockResolvedValue({ id: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const dbProduct = {
    findFirst: vi.fn().mockResolvedValue({ id: product.id }),
    findMany: vi.fn().mockResolvedValue([{ id: product.id }]),
  };
  const db = { favorite, product: dbProduct } as unknown as DbService;

  return {
    favorite,
    product: dbProduct,
    service: new FavoriteService(db),
  };
}

describe('FavoriteService', () => {
  it('lets a user add an active product idempotently', async () => {
    const { favorite, service } = setup();

    await service.add(7, product.id);
    await service.add(7, product.id);

    expect(favorite.upsert).toHaveBeenCalledTimes(2);
    expect(favorite.upsert).toHaveBeenLastCalledWith({
      where: { userId_productId: { userId: 7, productId: product.id } },
      update: {},
      create: { userId: 7, productId: product.id },
    });
  });

  it('rejects a missing or inactive product', async () => {
    const { favorite, product: dbProduct, service } = setup();
    dbProduct.findFirst.mockResolvedValue(null);

    await expect(service.add(7, 999)).rejects.toBeInstanceOf(NotFoundException);
    expect(dbProduct.findFirst).toHaveBeenCalledWith({
      where: { id: 999, active: true },
      select: { id: true },
    });
    expect(favorite.upsert).not.toHaveBeenCalled();
  });

  it('removes only the current user favorite', async () => {
    const { favorite, service } = setup();

    await service.remove(7, product.id);

    expect(favorite.deleteMany).toHaveBeenCalledWith({
      where: { userId: 7, productId: product.id },
    });
  });

  it('lists only active favorites of the current user', async () => {
    const { favorite, service } = setup();

    await expect(service.list(7)).resolves.toEqual({ items: [product] });
    expect(favorite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, product: { active: true } },
      }),
    );
  });

  it('deduplicates sync ids and creates only active existing products', async () => {
    const { favorite, product: dbProduct, service } = setup();
    dbProduct.findMany.mockResolvedValue([{ id: 10 }, { id: 12 }]);
    favorite.createMany.mockResolvedValue({ count: 2 });

    await expect(
      service.sync(7, { productIds: [10, 10, 11, 12] }),
    ).resolves.toEqual({ ok: true, added: 2 });

    expect(dbProduct.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10, 11, 12] }, active: true },
      select: { id: true },
    });
    expect(favorite.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 7, productId: 10 },
        { userId: 7, productId: 12 },
      ],
      skipDuplicates: true,
    });
  });

  it('safely ignores sync ids that do not resolve to active products', async () => {
    const { favorite, product: dbProduct, service } = setup();
    dbProduct.findMany.mockResolvedValue([]);

    await expect(service.sync(7, { productIds: [999] })).resolves.toEqual({
      ok: true,
      added: 0,
    });
    expect(favorite.createMany).not.toHaveBeenCalled();
  });
});

describe('favorite API validation and auth', () => {
  it('rejects invalid sync ids and oversized payloads', () => {
    expect(favoriteSyncSchema.safeParse({ productIds: [0] }).success).toBe(
      false,
    );
    expect(
      favoriteSyncSchema.safeParse({ productIds: Array(101).fill(1) }).success,
    ).toBe(false);
  });

  it('protects every server favorite route with AuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', FavoriteCtrl) as unknown[];

    expect(guards).toContain(AuthGuard);
  });
});
