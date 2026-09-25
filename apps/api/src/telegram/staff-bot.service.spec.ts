import { BadRequestException, Logger } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import type { StaffService } from '../staff/staff.service.js';
import type { TelegramService } from './telegram.service.js';
import type { StaffLinkService } from './staff-link.service.js';
import type { StaffBotFlowService } from './staff-bot-flow.service.js';
import { StaffBotService } from './staff-bot.service.js';

const callback = (data = 'order:6:confirm', chatType = 'private') => ({
  callback_query: {
    id: 'cb', from: { id: 123, is_bot: false }, data,
    message: { message_id: 44, chat: { id: 123, type: chatType } },
  },
});
const message = (text: string, chatType = 'private') => ({
  message: { message_id: 45, from: { id: 123, is_bot: false },
    chat: { id: 123, type: chatType }, text },
});
function setup(role: 'SELLER' | 'ADMIN' | 'USER' = 'SELLER') {
  const order = {
    id: 6, status: 'NEW' as string, type: 'PICKUP', customerName: 'Покупатель',
    customerPhone: '+79990000000', city: null, street: null, house: null, flat: null,
    comment: null, subtotal: 10000, deliveryPrice: null, total: 10000,
    finalSubtotal: null, finalTotal: null,
    payment: null as null | { status: string },
    delivery: null as null | { provider: string; status: string; externalOrderId?: string },
    items: [{ id: 8, productName: 'Картофель', unit: 'GRAM', qty: 700, price: 60000,
      priceQty: 1000, total: 42000, actualQty: null, actualTotal: null, status: 'PENDING' }],
    issues: [] as { orderItemId: number; replacementItemId: number | null }[],
    extras: [] as { id: number; title: string; status: string; version: number }[],
  };
  const findIdentity = vi.fn(async () => ({ id: 3, userId: 7, user: { role } }));
  const updateIdentity = vi.fn(async () => ({}));
  const findMany = vi.fn(async () => [{ id: 6, status: 'NEW', customerName: 'Покупатель', type: 'PICKUP' }]);
  const db = { staffTelegramIdentity: { findUnique: findIdentity, update: updateIdentity },
    order: { findMany } } as unknown as DbService;
  const staff = {
    get: vi.fn(async () => order),
    confirm: vi.fn(async () => { order.status = 'CONFIRMED'; }),
    startAssembly: vi.fn(async () => { order.status = 'ASSEMBLING'; }),
    item: vi.fn(async () => ({})),
    confirmDiscrete: vi.fn(async () => 1),
    finishAssembly: vi.fn(async () => { order.status = 'READY'; }),
    confirmPayment: vi.fn(async () => ({})),
    completePickup: vi.fn(async () => { order.status = 'COMPLETED'; }),
    reopen: vi.fn(async () => { order.status = 'ASSEMBLING'; }),
    extra: vi.fn(async () => ({})),
    delivery: vi.fn(async () => ({})),
    handoff: vi.fn(async () => { order.status = 'DELIVERING'; }),
    completeDelivery: vi.fn(async () => { order.status = 'COMPLETED'; }),
  };
  const telegram = {
    canManagePrivate: vi.fn((userId: number, chatId: number) => userId === 123 && chatId === 123),
    sendStaff: vi.fn(async () => {}), editStaff: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    staffOrderUrl: vi.fn(() => 'https://shop.example/staff/orders/6'),
  };
  const links = { link: vi.fn(async () => true) };
  const flows = {
    start: vi.fn(async () => true), input: vi.fn(async () => null),
    finish: vi.fn(async () => true), cancel: vi.fn(async () => true), resume: vi.fn(async () => {}),
  };
  const handler = new StaffBotService(db, staff as unknown as StaffService,
    telegram as unknown as TelegramService, links as unknown as StaffLinkService,
    flows as unknown as StaffBotFlowService);
  return { handler, order, staff, telegram, links, flows, findIdentity, updateIdentity, findMany };
}

describe('STAFF Telegram authorization and legacy callbacks', () => {
  it.each(['group', 'supergroup', 'channel'])('ignores %s messages and rejects callbacks', async type => {
    const s = setup();
    await s.handler.handle(message('/orders', type));
    await s.handler.handle(callback('order:6:confirm', type));
    expect(s.findIdentity).not.toHaveBeenCalled();
    expect(s.staff.confirm).not.toHaveBeenCalled();
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('cb', 'Нет доступа');
  });
  it('rejects chat/from mismatch and allowlist failure before identity lookup', async () => {
    const s = setup();
    const wrong = callback();
    wrong.callback_query.message.chat.id = 999;
    await s.handler.handle(wrong);
    s.telegram.canManagePrivate.mockReturnValue(false);
    await s.handler.handle(message('/orders'));
    expect(s.findIdentity).not.toHaveBeenCalled();
  });
  it.each(['SELLER', 'ADMIN'] as const)('accepts linked %s and preserves legacy confirm/assembly', async role => {
    const s = setup(role);
    await s.handler.handle(callback());
    expect(s.staff.confirm).toHaveBeenCalledWith(6, { userId: 7, role });
    await s.handler.handle(callback('order:6:assembly'));
    expect(s.staff.startAssembly).toHaveBeenCalledWith(6, { userId: 7, role });
    expect(s.telegram.editStaff).toHaveBeenCalled();
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledTimes(2);
  });
  it('rejects linked USER even when Telegram ID is allowlisted', async () => {
    const s = setup('USER');
    await s.handler.handle(callback());
    expect(s.staff.confirm).not.toHaveBeenCalled();
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('cb',
      'Сначала привяжите аккаунт сотрудника');
  });
  it('ACKs a role revoked during a domain transaction without retrying the webhook', async () => {
    const s = setup();
    const { ForbiddenException } = await import('@nestjs/common');
    s.staff.confirm.mockRejectedValueOnce(new ForbiddenException());
    await s.handler.handle(callback());
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('cb', 'Нет доступа');
    expect(s.staff.confirm).toHaveBeenCalledTimes(1);
  });
  it('cannot process a repeated or stale confirm', async () => {
    const s = setup();
    await s.handler.handle(callback());
    await s.handler.handle(callback());
    expect(s.staff.confirm).toHaveBeenCalledTimes(1);
    expect(s.telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cb', 'Статус заказа уже изменился');
  });
  it('ACKs malformed callback envelopes when an ID is available', async () => {
    const s = setup();
    await s.handler.handle({ callback_query: { id: 'broken', data: 's:6:o' } });
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('broken', 'Некорректная кнопка');
    expect(s.findIdentity).not.toHaveBeenCalled();
  });
  it('rejects malformed callbacks without order lookup', async () => {
    const s = setup();
    await s.handler.handle(callback('s:6:delete'));
    expect(s.staff.get).not.toHaveBeenCalled();
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('cb', 'Некорректная кнопка');
  });
  it('/link uses one-time code service and /start stores activation', async () => {
    const s = setup();
    await s.handler.handle(message('/link ' + 'A'.repeat(22)));
    expect(s.links.link).toHaveBeenCalledWith(123, 'A'.repeat(22));
    await s.handler.handle(message('/start'));
    expect(s.updateIdentity).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 3 }, data: expect.objectContaining({ blockedAt: null }),
    }));
  });
  it('does not log provider or private order values on unexpected failure', async () => {
    const s = setup();
    const logger = vi.spyOn((await import('@nestjs/common')).Logger.prototype, 'error')
      .mockImplementation(() => {});
    s.staff.get.mockRejectedValueOnce(new Error('SECRET +79990000000'));
    await expect(s.handler.handle(callback('s:6:o'))).rejects.toThrow('Staff Telegram update failed');
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('cb',
      'Результат действия не подтверждён. Проверьте заказ через /orders. Не повторяйте действие до проверки.');
    expect(logger).toHaveBeenCalledWith('Staff Telegram update failed');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('+79990000000');
    logger.mockRestore();
  });
  it('/orders is bounded and routes to staff order dashboards', async () => {
    const s = setup();
    await s.handler.handle(message('/orders'));
    expect(s.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 12 }));
    expect(s.telegram.sendStaff).toHaveBeenCalled();
  });
});

describe('STAFF seller domain operations use linked audit actor', () => {
  it('prompts for GRAM and PIECE actual quantities without editing snapshot price', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    await s.handler.handle(callback('s:6:w:8'));
    expect(s.flows.start).toHaveBeenCalledWith(3, 123, 44, 6, 8, 'ITEM', 'qty');
    expect(s.staff.item).not.toHaveBeenCalled();
    s.order.items[0]!.unit = 'PIECE';
    await s.handler.handle(callback('s:6:q:8'));
    expect(s.flows.start).toHaveBeenLastCalledWith(3, 123, 44, 6, 8, 'ITEM', 'qty');
  });
  it.each(['PIECE', 'PACK', 'BUNCH'] as const)('one-tap %s uses the audited domain method', async unit => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    s.order.items[0]!.unit = unit;
    await s.handler.handle(callback('s:6:a:8'));
    expect(s.staff.confirmDiscrete).toHaveBeenCalledWith(6, { userId: 7, role: 'SELLER' }, 8);
    expect(s.flows.start).not.toHaveBeenCalled();
    expect(s.telegram.editStaff).toHaveBeenCalled();
  });
  it('rejects quick and bulk actions for a linked USER', async () => {
    const s = setup('USER');
    s.order.status = 'ASSEMBLING';
    s.order.items[0]!.unit = 'PIECE';
    await s.handler.handle(callback('s:6:a:8'));
    await s.handler.handle(callback('s:6:k'));
    expect(s.staff.confirmDiscrete).not.toHaveBeenCalled();
  });
  it('bulk confirmation uses a single domain operation and GRAM has no instant action', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    await s.handler.handle(callback('s:6:a:8'));
    expect(s.staff.confirmDiscrete).not.toHaveBeenCalled();
    await s.handler.handle(callback('s:6:k'));
    expect(s.staff.confirmDiscrete).toHaveBeenCalledWith(6, { userId: 7, role: 'SELLER' }, undefined);
  });
  it('marks missing and resets to pending through StaffService.item with User.id', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    await s.handler.handle(callback('s:6:m:8'));
    expect(s.staff.item).toHaveBeenCalledWith(6, 8, { status: 'MISSING' }, 7,
      { userId: 7, role: 'SELLER' });
    s.order.items[0]!.status = 'MISSING';
    await s.handler.handle(callback('s:6:r:8'));
    expect(s.staff.item).toHaveBeenLastCalledWith(6, 8, { status: 'PENDING' }, 7,
      { userId: 7, role: 'SELLER' });
  });
  it('finishes assembly only in ASSEMBLING and confirms payment with linked User.id', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    await s.handler.handle(callback('s:6:f'));
    expect(s.staff.finishAssembly).toHaveBeenCalledWith(6, { userId: 7, role: 'SELLER' });
    s.order.payment = { status: 'AWAITING' };
    await s.handler.handle(callback('s:6:p'));
    expect(s.staff.confirmPayment).toHaveBeenCalledWith(6, 7, undefined,
      { userId: 7, role: 'SELLER' });
  });
  it('keeps domain finish-assembly refusal visible without exposing error details', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    s.staff.finishAssembly.mockRejectedValueOnce(new BadRequestException('private issue details'));
    await s.handler.handle(callback('s:6:f'));
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith('cb',
      'Сборку нельзя завершить: проверьте позиции и вопросы покупателя. Обновите заказ.');
    expect(s.telegram.editStaff).toHaveBeenCalled();
  });
  it('completes paid pickup through StaffService', async () => {
    const s = setup();
    s.order.status = 'READY';
    s.order.payment = { status: 'PAID' };
    await s.handler.handle(callback('s:6:u'));
    expect(s.staff.completePickup).toHaveBeenCalledWith(6, { userId: 7, role: 'SELLER' });
  });
  it('handles OTHER delivery through existing delivery/handoff/complete methods', async () => {
    const s = setup();
    s.order.status = 'READY';
    s.order.type = 'DELIVERY';
    s.order.payment = { status: 'PAID' };
    await s.handler.handle(callback('s:6:d'));
    expect(s.flows.start).toHaveBeenCalledWith(3, 123, 44, 6, null, 'DELIVERY',
      'courierName');
    s.order.delivery = { provider: 'OTHER', status: 'ASSIGNED' };
    await s.handler.handle(callback('s:6:h'));
    expect(s.staff.handoff).toHaveBeenCalledWith(6, { userId: 7, role: 'SELLER' });
    await s.handler.handle(callback('s:6:c'));
    expect(s.staff.completeDelivery).toHaveBeenCalledWith(6, { userId: 7, role: 'SELLER' });
  });
  it('keeps Yandex delivery on existing integration and website fallback', async () => {
    const s = setup();
    s.order.status = 'READY';
    s.order.type = 'DELIVERY';
    s.order.payment = { status: 'PAID' };
    s.order.delivery = { provider: 'YANDEX', status: 'ASSIGNED' };
    await s.handler.handle(callback('s:6:d'));
    expect(s.flows.start).not.toHaveBeenCalled();
    expect(s.staff.delivery).not.toHaveBeenCalled();
  });
  it('requires a reason and confirmation before audited cancellation', async () => {
    const s = setup('ADMIN');
    await s.handler.handle(callback('order:6:cancel_request'));
    expect(s.flows.start).toHaveBeenCalledWith(3, 123, 44, 6, null,
      'CANCEL', 'reason');
    await s.handler.handle(callback('s:6:zy:0123456789abcdef'));
    expect(s.flows.finish).toHaveBeenCalledWith(3, { userId: 7, role: 'ADMIN' }, 6, 'CANCEL', '0123456789abcdef');
  });
  it('reuses StaffService.extra for active extras and never accepts price in callback data', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    await s.handler.handle(callback('s:6:x'));
    expect(s.flows.start).toHaveBeenCalledWith(3, 123, 44, 6, null,
      'EXTRA', 'title', {});
    await s.handler.handle(callback('s:6:xs:0123456789abcdef'));
    expect(s.flows.finish).toHaveBeenCalledWith(3, { userId: 7, role: 'SELLER' }, 6, 'EXTRA', '0123456789abcdef');
  });
});

describe('STAFF recovery command authorization and business error UX', () => {
  it.each(['SELLER', 'ADMIN'] as const)('allows /resume only for linked %s', async role => {
    const s = setup(role);
    await s.handler.handle(message('/resume'));
    expect(s.flows.resume).toHaveBeenCalledExactlyOnceWith(3, 123);
  });
  it.each(['group', 'supergroup', 'channel'])('ignores /resume in %s', async type => {
    const s = setup();
    await s.handler.handle(message('/resume', type));
    expect(s.flows.resume).not.toHaveBeenCalled();
    expect(s.findIdentity).not.toHaveBeenCalled();
  });
  it('rejects /resume on chat mismatch, allowlist denial, or linked USER', async () => {
    const s = setup();
    const wrong = message('/resume');
    wrong.message.chat.id = 999;
    await s.handler.handle(wrong);
    s.telegram.canManagePrivate.mockReturnValue(false);
    await s.handler.handle(message('/resume'));
    expect(s.flows.resume).not.toHaveBeenCalled();
    const customer = setup('USER');
    await customer.handler.handle(message('/resume'));
    expect(customer.flows.resume).not.toHaveBeenCalled();
  });
  it('points to /resume when the first prompt is unbound', async () => {
    const s = setup();
    s.order.status = 'ASSEMBLING';
    s.flows.start.mockResolvedValueOnce(false);
    await s.handler.handle(callback('s:6:x'));
    expect(s.telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cb', expect.stringContaining('/resume'));
  });
  it('does not claim a COMMITTING flow was canceled', async () => {
    const s = setup();
    s.flows.cancel.mockResolvedValue(false);
    await s.handler.handle(message('/cancel'));
    expect(s.telegram.sendStaff).toHaveBeenLastCalledWith(123, expect.stringContaining('не подтверждён'));
    await s.handler.handle(callback('s:6:zb'));
    expect(s.telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cb', expect.stringContaining('не подтверждён'));
  });
  it.each(['Максимальная цена услуги — 5000 ₽.', 'Максимальная сумма услуг — 10000 ₽.'])(
    'shows a safe domain limit with recovery instructions: %s', async text => {
      const s = setup();
      s.flows.finish.mockRejectedValueOnce(new BadRequestException(text));
      await s.handler.handle(callback('s:6:xs:0123456789abcdef'));
      expect(s.telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cb',
        text + ' Данные сохранены. /resume — продолжить, /cancel — отменить.');
      expect(s.staff.extra).not.toHaveBeenCalled();
    });
  it('does not expose arbitrary 400 details in the callback ACK', async () => {
    const s = setup();
    s.flows.finish.mockRejectedValueOnce(new BadRequestException('PRIVATE_PROVIDER_DETAILS'));
    await s.handler.handle(callback('s:6:xs:0123456789abcdef'));
    expect(JSON.stringify(s.telegram.answerCallbackQuery.mock.calls)).not.toContain('PRIVATE_PROVIDER_DETAILS');
    expect(s.telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cb', expect.stringContaining('/resume'));
  });
  it('acknowledges business success even if dashboard rendering throws', async () => {
    const s = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      s.telegram.editStaff.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_DETAILS'));
      await s.handler.handle(callback('s:6:xs:0123456789abcdef'));
      expect(s.flows.finish).toHaveBeenCalledTimes(1);
      expect(s.telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cb', 'Заказ обновлён. /orders — открыть заказ.');
      expect(warn).toHaveBeenCalledWith('Staff Telegram saved order refresh failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_PROVIDER_DETAILS');
    } finally { warn.mockRestore(); }
  });
});
