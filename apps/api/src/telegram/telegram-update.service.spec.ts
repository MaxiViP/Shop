import { TelegramUpdateService } from './telegram-update.service.js';
import type { StaffBotService } from './staff-bot.service.js';

describe('STAFF webhook routing', () => {
  it('passes message and callback updates to the authorized seller workflow', async () => {
    const handle = vi.fn(async () => {});
    const service = new TelegramUpdateService({ handle } as unknown as StaffBotService);
    const message = { message: { text: '/orders' } };
    const callback = { callback_query: { data: 'order:1:confirm' } };
    await service.handle(message);
    await service.handle(callback);
    expect(handle).toHaveBeenNthCalledWith(1, message);
    expect(handle).toHaveBeenNthCalledWith(2, callback);
  });
});
