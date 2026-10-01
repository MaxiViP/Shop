import { productListSelect } from '../product/select.js';
import { cartProductSelect } from '../order/cart-quote.js';
import { ProductService } from '../product/product.service.js';
import { OrderService } from '../order/order.service.js';
import { StaffService } from '../staff/staff.service.js';
import { telegramOrderSelect } from '../telegram/message.js';
import type { TelegramService } from '../telegram/telegram.service.js';
import type { NotificationService } from '../order/notification.service.js';
import type { DbService } from '../db/db.service.js';
const privateFields = [
  'basePrice', 'settlementMode', 'basePriceSnapshot', 'settlementModeSnapshot',
  'sharedMarkup', 'partner1Share', 'partner2Share',
];
describe('public financial privacy boundary', () => {
  it('excludes settlement fields from catalog, detail, cart, favorites and Telegram selectors', () => {
    for (const select of [productListSelect, cartProductSelect])
      for (const field of privateFields) expect(select).not.toHaveProperty(field);
    for (const field of privateFields) {
      expect(telegramOrderSelect).not.toHaveProperty(field);
      expect(telegramOrderSelect.items.select).not.toHaveProperty(field);
    }
  });
  it('uses the explicit safe selector for public product detail', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 1, name: 'Помидоры' });
    const service = new ProductService({ product: { findFirst } } as unknown as DbService);
    await service.get('tomatoes');
    const select = findFirst.mock.calls[0]![0].select;
    for (const field of privateFields) expect(select).not.toHaveProperty(field);
  });
  it('does not select private snapshots in customer order and staff detail', async () => {
    const customerFind = vi.fn().mockResolvedValue({ status: 'NEW', assemblyFinalizedAt: null, extras: [] });
    const customer = new OrderService({ order: { findFirst: customerFind } } as unknown as DbService,
      {} as TelegramService);
    await customer.get('00000000-0000-0000-0000-000000000001', 1);
    const customerSelect = customerFind.mock.calls[0]![0].select.items.select;
    for (const field of privateFields) expect(customerSelect).not.toHaveProperty(field);
    const staffFind = vi.fn().mockResolvedValue({ cancellations: [], items: [], status: 'NEW' });
    const staff = new StaffService({ order: { findUnique: staffFind } } as unknown as DbService,
      {} as NotificationService);
    await staff.get(1);
    const staffSelect = staffFind.mock.calls[0]![0].select.items.select;
    for (const field of privateFields) expect(staffSelect).not.toHaveProperty(field);
  });
});
