import { DbService } from '../db/db.service.js';
import { NotificationService } from '../order/notification.service.js';
import { StaffService } from './staff.service.js';
import { itemQuoteSchema } from './schema.js';

const actor = { userId: 7, role: 'SELLER' as const };
const gram = {
  id: 10, orderId: 1, status: 'PENDING', unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE',
  qty: 750, price: 32000, actualPrice: null, priceQty: 1000, total: 24000,
  actualQty: null, actualWeightGrams: null, pieceWeights: null,
};
function setup(item: object = gram) {
  const order = { status: 'ASSEMBLING', assemblyFinalizedAt: null, weightToleranceBps: 1000,
    payment: null, items: [item], issues: [] };
  const read = vi.fn().mockResolvedValue(order);
  const db = { order: { findUnique: read } };
  const service = new StaffService(db as unknown as DbService, {} as NotificationService);
  return { service, order, read };
}
it('quotes integer grams using the order snapshot without changing any data', async () => {
  const { service, read } = setup();
  expect(await service.itemQuote(1, 10, { status: 'PICKED', actualQty: 782 }, actor)).toEqual({
    actualQty: 782, actualWeightGrams: null, actualTotal: 25024,
    quantityDelta: 32, amountDelta: 1024, requiresApproval: false,
  });
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
});
it('uses current actualPrice and reports when customer approval is required', async () => {
  const { service } = setup({ ...gram, actualPrice: 40000 });
  expect(await service.itemQuote(1, 10, { status: 'PICKED', actualQty: 900 }, actor)).toMatchObject({
    actualTotal: 36000, amountDelta: 12000, requiresApproval: true,
  });
});
it('keeps an unknown original whole-weight amount unknown and validates each piece', async () => {
  const { service } = setup({ ...gram, unit: 'PIECE', saleModel: 'WHOLE_VARIABLE_WEIGHT', qty: 2,
    total: null, weightMinGrams: 500, weightMaxGrams: 900 });
  const body = { status: 'PICKED' as const, actualQty: 2, pieceWeights: [700, 800] };
  expect(await service.itemQuote(1, 10, body, actor)).toMatchObject({
    actualWeightGrams: 1500, actualTotal: 48000, amountDelta: null, requiresApproval: false,
  });
  await expect(service.itemQuote(1, 10, { ...body, pieceWeights: [700] }, actor)).rejects.toThrow();
  expect(await service.itemQuote(1, 10, { ...body, pieceWeights: [700, 950] }, actor))
    .toMatchObject({ requiresApproval: true });
});
it.each([
  { status: 'READY' }, { assemblyFinalizedAt: new Date() }, { payment: { status: 'PAID' } },
  { items: [] }, { items: [{ ...gram, status: 'PICKED' }] },
  { issues: [{ replacementItemId: 11 }] },
  { issues: [{ status: 'RESOLVED', resolution: 'REMOVE_ITEM' }] },
])('refuses a noneditable quote %j', async change => {
  const { service, order } = setup();
  Object.assign(order, change);
  await expect(service.itemQuote(1, 10, { status: 'PICKED', actualQty: 782 }, actor)).rejects.toThrow();
});
it('rejects absent orders and invalid input rather than rounding quantities', async () => {
  const { service, read } = setup();
  read.mockResolvedValue(null);
  await expect(service.itemQuote(1, 10, { status: 'PICKED', actualQty: 782 }, actor)).rejects.toThrow();
  for (const actualQty of [0, -1, 782.5, 1000001]) {
    expect(itemQuoteSchema.safeParse({ status: 'PICKED', actualQty }).success).toBe(false);
  }
});
