import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import { SeasonsService } from './seasons.service.js';
import { seasonAssignment, seasonSchema } from './seasons.schema.js';

function fixture() {
  const tx = {
    seasonTemplate: { findUnique: vi.fn().mockResolvedValue({ id: 7 }) },
    product: { count: vi.fn().mockResolvedValue(2), updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const transaction = vi.fn(async (run: (db: typeof tx) => Promise<unknown>) => run(tx));
  return { tx, transaction, service: new SeasonsService({ $transaction: transaction } as unknown as DbService) };
}
const assignment = { ids: [1, 3], seasonalMode: 'AUTO' as const, seasonTemplateId: 7 };

describe('Calendar templates and selected-product assignment', () => {
  it('permits annual, single-month and wrapped templates but rejects invalid months', () => {
    for (const [startMonth, endMonth] of [[1, 12], [10, 10], [11, 2]])
      expect(seasonSchema.safeParse({ name: 'Сезон', startMonth, endMonth, active: true }).success).toBe(true);
    expect(seasonSchema.safeParse({ name: 'Сезон', startMonth: 0, endMonth: 13, active: true }).success).toBe(false);
    expect(seasonAssignment.safeParse({ ...assignment, seasonTemplateId: null }).success).toBe(false);
    expect(seasonAssignment.safeParse({ ...assignment, ids: [1, 1] }).success).toBe(false);
    expect(seasonAssignment.safeParse({ ...assignment, ids: Array.from({ length: 101 }, (_, index) => index + 1) }).success).toBe(false);
  });

  it.each(['AUTO', 'MANUAL', 'OFF'] as const)('assigns %s to exactly the selected products with one update', async seasonalMode => {
    const { tx, service } = fixture();
    await expect(service.assign({ ...assignment, seasonalMode })).resolves.toEqual({ count: 2 });
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1, 3] } }, data: {
      seasonalMode, seasonTemplateId: 7, isSeasonal: seasonalMode === 'MANUAL', seasonalStartsAt: null, seasonalEndsAt: null,
    } });
  });

  it('rejects a missing template or selected product before any mutation', async () => {
    const { tx, service } = fixture();
    tx.seasonTemplate.findUnique.mockResolvedValue(null);
    await expect(service.assign(assignment)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    tx.seasonTemplate.findUnique.mockResolvedValue({ id: 7 });
    tx.product.count.mockResolvedValue(1);
    await expect(service.assign(assignment)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it('fails the transaction when a product disappears between count and update instead of accepting a partial assignment', async () => {
    const { tx, service } = fixture();
    tx.product.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.assign(assignment)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
  });
});
