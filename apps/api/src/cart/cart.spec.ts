import type { DbService } from '../db/db.service.js';
import type { OrderService } from '../order/order.service.js';
import { CartService, type CartChange } from './cart.service.js';

it.each<CartChange>([
  { kind: 'plus', productId: 1 }, { kind: 'minus', productId: 1 },
  { kind: 'add', productId: 1, qty: 1 },
  { kind: 'set', productId: 1, qty: 1 },
  { kind: 'set', productId: 1, qty: 1, quantityUnit: 'GRAM' },
])('rejects stale quantity units before any cart writes: %j', async change => {
  const cart = { id: 1, revision: 'revision', items: [{ productId: 1, qty: 500, quantityUnit: 'GRAM' }] };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: 1 }]),
    cart: { upsert: vi.fn().mockResolvedValue(cart), findUniqueOrThrow: vi.fn().mockResolvedValue(cart), update: vi.fn() },
    product: { findFirst: vi.fn().mockResolvedValue({ id: 1, unit: 'PIECE', priceUnit: 'GRAM',
      saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1, portionQty: 1 }) },
    cartItem: { upsert: vi.fn() },
  };
  const db = { $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) };
  const service = new CartService(db as unknown as DbService, {} as OrderService);
  await expect(service.change(1, 'revision', change)).rejects.toThrow('Способ продажи изменился');
  expect(tx.cartItem.upsert).not.toHaveBeenCalled();
  expect(tx.cart.update).not.toHaveBeenCalled();
});
it('rejects a stale incoming unit even when the saved cart uses the current unit', async () => {
  const cart = { id: 1, revision: 'revision', items: [{ productId: 1, qty: 2, quantityUnit: 'PIECE' }] };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: 1 }]),
    cart: { upsert: vi.fn().mockResolvedValue(cart), findUniqueOrThrow: vi.fn().mockResolvedValue(cart), update: vi.fn() },
    product: { findFirst: vi.fn().mockResolvedValue({ id: 1, unit: 'PIECE', priceUnit: 'PIECE', min: 1, step: 1, portionQty: 1 }) },
    cartItem: { upsert: vi.fn() },
  };
  const db = { $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) };
  const service = new CartService(db as unknown as DbService, {} as OrderService);
  await expect(service.change(1, 'revision', { kind: 'set', productId: 1, qty: 500, quantityUnit: 'GRAM' }))
    .rejects.toThrow('Способ продажи изменился');
  expect(tx.cartItem.upsert).not.toHaveBeenCalled();
});
