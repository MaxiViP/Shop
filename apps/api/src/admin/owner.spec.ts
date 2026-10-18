import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import { AdminProductsService } from './products.service.js';
import { AdminUsersService } from './users.service.js';
import { ImagesService } from './images.service.js';
import { ownerProductFields, ownerProductPatch, productQuery, pointOwnersSchema } from './schema.js';
import { isStaff } from '../auth/permissions.js';
import { staffActor, recordStaffAudit } from '../staff/audit.js';

const input = { name: 'Яблоки', slug: 'apples', description: null, price: 10000, priceQty: 1000,
  unit: 'GRAM' as const, min: 500, step: 100, portionQty: 500, categoryId: 1, marketPointId: 10, active: true };
const own = { id: 1, ...input, serviceMarkupPercent: 25, sort: 0, settlementMode: 'UNSET' as const,
  basePrice: null, seasonalMode: 'OFF' as const, seasonTemplateId: null, isSeasonal: false, isHit: false, hitMode: 'AUTO' as const };
function fixture() {
  const grants = new Set([10]);
  const product = { ...own };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ role: 'USER' }]),
    $transaction: vi.fn(),
    marketPointOwner: {
      count: vi.fn(async () => grants.size),
      findUnique: vi.fn(async ({ where }) => grants.has(where.userId_marketPointId.marketPointId) ? {} : null),
      deleteMany: vi.fn(), createMany: vi.fn(),
    },
    marketPoint: { count: vi.fn(async ({ where }) => where.id.in.length) },
    category: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    product: {
      findUnique: vi.fn(async ({ where }) => where.id === 1 && where.marketPoint?.owners?.some?.userId === 7 ? product : null),
      update: vi.fn(async ({ data }) => Object.assign(product, data)),
      create: vi.fn(async ({ data }) => ({ id: 3, ...data })),
      findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
    },
    productImage: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 7, phone: '+79990000007', role: 'SELLER', ownedPoints: [] }), findUniqueOrThrow: vi.fn() },
    session: { deleteMany: vi.fn() },
    adminAudit: { create: vi.fn() }, orderStaffAudit: { create: vi.fn() },
  };
  db.$transaction.mockImplementation((run: ((tx: typeof db) => unknown) | Promise<unknown>[]) => typeof run === 'function' ? run(db) : Promise.all(run));
  const client = db as unknown as DbService;
  const images = new ImagesService(client);
  return { db, grants, product, images, products: new AdminProductsService(client, images), users: new AdminUsersService(client) };
}

describe('Point owner permissions', () => {
  it('combines buyer, fulfillment and assigned-point capabilities without replacing seller/admin roles', () => {
    expect(isStaff({ role: 'USER' })).toBe(false);
    expect(isStaff({ role: 'USER', ownedPoints: [{ marketPointId: 10 }] })).toBe(true);
    expect(isStaff({ role: 'SELLER', ownedPoints: [{ marketPointId: 10 }] })).toBe(true);
    expect(staffActor({ id: 7, role: 'USER', ownedPoints: [{ marketPointId: 10 }] })).toEqual({ userId: 7, role: 'SELLER' });
  });
  it.each(['hitMode', 'isHit', 'seasonalMode', 'sort', 'settlementMode', 'basePrice', 'serviceMarkupPercent', 'priceStatus', 'ownerId'])(
    'rejects an owner-supplied %s instead of silently trusting it', key => {
      expect(ownerProductPatch.safeParse({ [key]: 1 }).success).toBe(false);
      expect(ownerProductFields.safeParse({ ...input, [key]: 1 }).success).toBe(false);
    });
  it('requires an assigned point on creation and validates integer seller quantities', () => {
    expect(ownerProductFields.safeParse(input).success).toBe(true);
    expect(ownerProductFields.safeParse({ ...input, marketPointId: null }).success).toBe(false);
    expect(ownerProductFields.safeParse({ ...input, price: 10.5 }).success).toBe(false);
    expect(pointOwnersSchema.safeParse({ pointIds: [10, 10] }).success).toBe(false);
  });
  it('restricts both product reads and every list/count query to the live ownership relation', async () => {
    const { products, db } = fixture();
    await expect(products.get(2, 7)).rejects.toThrow(NotFoundException);
    await products.list(productQuery.parse({}), 7);
    expect(db.product.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { marketPoint: { owners: { some: { userId: 7 } } } } });
    for (const [query] of db.product.count.mock.calls) expect(query).toMatchObject({ where: { marketPoint: { owners: { some: { userId: 7 } } } } });
  });
  it('updates the owner seller price and keeps the admin markup and badges', async () => {
    const { products, product } = fixture();
    const result = await products.update(1, { price: 20000 }, 7, 7);
    expect(result.customerPrice).toBe(25000);
    expect(product).toMatchObject({ price: 20000, serviceMarkupPercent: 25, hitMode: 'AUTO' });
  });
  it('rejects a foreign product, point reassignment and a revoked grant before writing', async () => {
    const { products, db, grants } = fixture();
    await expect(products.update(2, { price: 20000 }, 7, 7)).rejects.toThrow(NotFoundException);
    await expect(products.update(1, { marketPointId: 20 }, 7, 7)).rejects.toThrow(NotFoundException);
    await expect(products.create({ ...input, marketPointId: 20, sort: 0 }, 7, 7)).rejects.toThrow(NotFoundException);
    grants.clear();
    await expect(products.update(1, { price: 20000 }, 7, 7)).rejects.toThrow(ForbiddenException);
    expect(db.product.update).not.toHaveBeenCalled();
    expect(db.product.create).not.toHaveBeenCalled();
  });
  it.each(['update', 'primary', 'remove'] as const)('blocks foreign product images for %s', async method => {
    const { images, db } = fixture();
    const result = method === 'update' ? images.update(2, 100, { alt: 'Фото' }, 7) : images[method](2, 100, 7);
    await expect(result).rejects.toThrow(NotFoundException);
    expect(db.productImage.update).not.toHaveBeenCalled();
    expect(db.productImage.delete).not.toHaveBeenCalled();
  });
  it('assigns multiple points without changing the independent seller role, and invalidates earlier sessions', async () => {
    const { users, db } = fixture();
    await users.points(7, [10, 20], 1);
    expect(db.marketPointOwner.createMany).toHaveBeenCalledWith({ data: [{ userId: 7, marketPointId: 10 }, { userId: 7, marketPointId: 20 }] });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(db.adminAudit.create).toHaveBeenCalled();
  });
  it('rechecks inherited fulfillment permission inside the order transaction', async () => {
    const { db } = fixture();
    db.user.findUnique.mockResolvedValue({ id: 7, phone: '+79990000007', role: 'USER', ownedPoints: [{ marketPointId: 10 }] });
    await recordStaffAudit(db as unknown as DbService, 3, { userId: 7, role: 'SELLER' }, 'CONFIRM');
    expect(db.orderStaffAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: 'SELLER', userId: 7 }) });
    db.user.findUnique.mockResolvedValue({ id: 7, phone: '+79990000007', role: 'USER', ownedPoints: [] });
    await expect(recordStaffAudit(db as unknown as DbService, 3, { userId: 7, role: 'SELLER' }, 'CONFIRM')).rejects.toThrow(ForbiddenException);
  });
});
