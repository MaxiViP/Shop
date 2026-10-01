import { PayoutsService } from './payouts.service.js';
import type { DbService } from '../db/db.service.js';
const input = {
  partner: 1, periodFrom: '2026-10-01', periodTo: '2026-10-07',
  amount: 1725000, paidAt: '2026-10-08T10:00:00.000Z', comment: null,
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
};
type Row = { id: number; partner: number; amount: number; periodFrom: Date;
  periodTo: Date; paidAt: Date; comment: string | null; idempotencyKey: string };
function fixture() {
  const rows: Row[] = [];
  const create = vi.fn(({ data }: { data: Omit<Row, 'id'> }) => {
    const row = { id: rows.length + 1, ...data };
    rows.push(row);
    return row;
  });
  const audit = vi.fn().mockResolvedValue({ id: 1 });
  const tx = {
    partnerPayout: {
      findUnique: vi.fn(({ where }: { where: { idempotencyKey: string } }) =>
        rows.find(row => row.idempotencyKey === where.idempotencyKey) ?? null),
      findFirst: vi.fn(({ where }: { where: { partner: number; amount: number;
        periodFrom: Date; periodTo: Date } }) => rows.find(row =>
        row.partner === where.partner && row.amount === where.amount &&
        row.periodFrom.getTime() === where.periodFrom.getTime() &&
        row.periodTo.getTime() === where.periodTo.getTime()) ?? null),
      create,
    },
    adminAudit: { create: audit },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const db = { ...tx, $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) } as unknown as DbService;
  return { service: new PayoutsService(db), rows, create, audit };
}

it('records one immutable event for a repeated idempotency key', async () => {
  const { service, create, audit } = fixture();
  await service.create(input, 7);
  await service.create(input, 7);
  expect(create).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledTimes(1);
});

it('rejects a duplicate period/partner/amount with a new key and permits a correction', async () => {
  const { service, rows, audit } = fixture();
  await service.create(input, 7);
  await expect(service.create({ ...input,
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
  }, 7)).rejects.toMatchObject({ status: 409, response: { code: 'PAYOUT_DUPLICATE' } });
  await service.create({ ...input, amount: -input.amount,
    idempotencyKey: '00000000-0000-4000-8000-000000000003',
  }, 7);
  expect(rows.map(row => row.amount)).toEqual([input.amount, -input.amount]);
  expect(audit).toHaveBeenCalledTimes(2);
});
