import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import { productListSelect } from '../product/select.js';
import { ImagesService } from './images.service.js';

function fixture() {
  const rows = [
    { id: 1, productId: 7, sort: 0, visible: true },
    { id: 2, productId: 7, sort: 0, visible: true },
    { id: 3, productId: 7, sort: 2, visible: false },
  ];
  const db = {
    $queryRaw: vi.fn(),
    productImage: {
      findMany: vi
        .fn()
        .mockImplementation(async () =>
          [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id),
        ),
      update: vi
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where: { id: number; productId: number };
            data: { sort?: number; visible?: boolean };
          }) => {
            const row = rows.find(
              (image) =>
                image.id === where.id && image.productId === where.productId,
            )!;
            Object.assign(row, data);
            return row;
          },
        ),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
    fn(db),
  );
  return { db, rows, service: new ImagesService(db as unknown as DbService) };
}

describe('Image visibility and primary ordering', () => {
  it('hides and restores a non-primary image', async () => {
    const { service } = fixture();
    expect(await service.update(7, 2, { visible: false })).toMatchObject({
      visible: false,
    });
    expect(await service.update(7, 2, { visible: true })).toMatchObject({
      visible: true,
    });
  });
  it('rejects hiding the primary, including equal-sort ties', async () => {
    const { service, db } = fixture();
    await expect(
      service.update(7, 1, { visible: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.productImage.update).not.toHaveBeenCalled();
  });
  it('makes a hidden image visible and deterministically renumbers in one transaction', async () => {
    const { service, db } = fixture();
    expect(await service.primary(7, 3)).toEqual([
      { id: 3, productId: 7, sort: 0, visible: true },
      { id: 1, productId: 7, sort: 1, visible: true },
      { id: 2, productId: 7, sort: 2, visible: true },
    ]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.productImage.findMany).toHaveBeenCalledWith({
      where: { productId: 7 },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
  });
  it('cannot select or update another product image', async () => {
    const { service, db } = fixture();
    await expect(service.primary(7, 99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.update(7, 99, { visible: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.productImage.update).not.toHaveBeenCalled();
  });
  it('public detail/list/favorites select visible images in main-first order', () => {
    expect(productListSelect.images.where).toEqual({ visible: true });
    expect(productListSelect.images.orderBy).toEqual([
      { sort: 'asc' },
      { id: 'asc' },
    ]);
  });
});
