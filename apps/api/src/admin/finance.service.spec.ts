import { FinanceService } from './finance.service.js';
import type { DbService } from '../db/db.service.js';
const completedAt = new Date('2026-10-01T10:00:00.000Z');
function fixture(at = completedAt) {
  const findMany = vi.fn().mockResolvedValue([{
    id: 1, publicId: '00000000-0000-0000-0000-000000000001',
    completedAt: at, customerName: 'Покупатель', finalTotal: 46200,
    deliveryPrice: 500,
    items: [{ id: 1, productName: 'Помидоры', status: 'PICKED', qty: 1000,
      actualQty: 1000, total: 45000, actualTotal: 45000, price: 45000, actualPrice: null, priceQty: 1000,
      settlementModeSnapshot: 'SHARED_MARKUP', basePriceSnapshot: 30000 }],
    extras: [{ amount: 700 }],
  }]);
  const db = {
    order: { findMany, aggregate: vi.fn().mockResolvedValue({ _count: { id: 1 }, _sum: { total: 9999 } }),
      count: vi.fn().mockResolvedValue(2) },
    shopSettings: { findUniqueOrThrow: vi.fn().mockResolvedValue({
      partner1Name: 'Максим', partner2Name: 'Партнёр 2',
    }) },
  } as unknown as DbService;
  return { service: new FinanceService(db), findMany };
}
describe('ADMIN financial report', () => {
  it('uses completedAt and COMPLETED only, with distinct goods, extras and delivery', async () => {
    const { service, findMany } = fixture();
    const report = await service.report({ period: 'custom', from: '2026-10-01', to: '2026-10-01' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      status: 'COMPLETED', completedAt: {
        gte: new Date('2026-09-30T21:00:00.000Z'),
        lt: new Date('2026-10-01T21:00:00.000Z'),
      },
    } }));
    expect(report).toMatchObject({ ordersCount: 1, turnover: 46200,
      goodsRevenue: 45000, delivery: 500, extras: 700,
      sharedMarkup: 15000, partner1Share: 7500, partner2Share: 7500,
      legacyCompletedCount: 2, cancelled: { count: 1, amount: 9999 } });
    expect(report.days[0]).toMatchObject({ date: '2026-10-01', ordersCount: 1, turnover: 46200 });
  });
  it('exports UTF-8 BOM, semicolon separators and Russian headers', async () => {
    const { service } = fixture();
    const csv = await service.csv({ period: 'custom', from: '2026-10-01', to: '2026-10-01' });
    expect(csv.filename).toBe('finance_2026-10-01_2026-10-01.csv');
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain('"Дата";"Заказов";"Оборот"');
  });
  it('assigns 21:30 UTC on October 1 to October 2 in Moscow', async () => {
    const { service, findMany } = fixture(new Date('2026-10-01T21:30:00.000Z'));
    const report = await service.report({ period: 'custom', from: '2026-10-02', to: '2026-10-02' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      status: 'COMPLETED', completedAt: {
        gte: new Date('2026-10-01T21:00:00.000Z'),
        lt: new Date('2026-10-02T21:00:00.000Z'),
      },
    } }));
    expect(report.days).toMatchObject([{ date: '2026-10-02', ordersCount: 1, turnover: 46200 }]);
  });
});
