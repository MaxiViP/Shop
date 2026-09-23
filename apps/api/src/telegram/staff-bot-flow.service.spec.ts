import type { DbService } from '../db/db.service.js';
import type { StaffService } from '../staff/staff.service.js';
import type { TelegramService } from './telegram.service.js';
import { StaffBotFlowService } from './staff-bot-flow.service.js';

type Session = {
  identityId: number; action: string; step: string; orderId: number; itemId: number | null;
  promptMessageId: number | null; dashboardMessageId: number | null;
  confirmationCode: string | null;
  payload: object; expiresAt: Date; updatedAt: Date;
};
function setup() {
  let session: Session | null = null;
  let nextPrompt = 80;
  const getSession = vi.fn(async () => session);
  const upsert = vi.fn(async ({ create, update }: { create: Omit<Session, 'updatedAt'>;
    update: Partial<Session> }) => {
    session = session ? { ...session, ...update, updatedAt: new Date() } :
      { ...create, updatedAt: new Date() };
    return session;
  });
  const updateMany = vi.fn(async ({ where, data }: { where: {
    identityId: number; step?: string; promptMessageId?: number | null; orderId?: number };
    data: Partial<Session> }) => {
    if (!session || where.identityId !== session.identityId ||
      (where.step !== undefined && where.step !== session.step) ||
      (where.promptMessageId !== undefined && where.promptMessageId !== session.promptMessageId) ||
      (where.orderId !== undefined && where.orderId !== session.orderId)) return { count: 0 };
    session = { ...session, ...data, updatedAt: new Date() };
    return { count: 1 };
  });
  const deleteMany = vi.fn(async ({ where }: { where: {
    identityId: number; step?: string; action?: string; orderId?: number;
    promptMessageId?: number | null } }) => {
    if (!session || where.identityId !== session.identityId ||
      (where.step !== undefined && where.step !== session.step) ||
      (where.action !== undefined && where.action !== session.action) ||
      (where.orderId !== undefined && where.orderId !== session.orderId) ||
      (where.promptMessageId !== undefined && where.promptMessageId !== session.promptMessageId))
      return { count: 0 };
    session = null;
    return { count: 1 };
  });
  const db = { staffTelegramSession: { findUnique: getSession, upsert, updateMany, deleteMany } } as unknown as DbService;
  const staff = {
    get: vi.fn(async () => ({ status: 'ASSEMBLING',
      items: [{ id: 8, status: 'PENDING', unit: 'GRAM' }] })),
    item: vi.fn(async () => ({})), extra: vi.fn(async () => ({})),
    delivery: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})),
  };
  const telegram = {
    promptStaff: vi.fn(async () => nextPrompt++),
    sendStaff: vi.fn(async () => {}),
    editStaff: vi.fn(async () => {}),
  };
  const flow = new StaffBotFlowService(db, staff as unknown as StaffService,
    telegram as unknown as TelegramService);
  const reply = (text: string, promptId = session?.promptMessageId ?? 80) => ({
    message_id: 100, from: { id: 123, is_bot: false },
    chat: { id: 123, type: 'private' }, text,
    reply_to_message: { message_id: promptId },
  });
  return { flow, staff, telegram, reply, get session() { return session; },
    setExpired: () => { if (session) session.expiresAt = new Date(Date.now() - 1); } };
}

describe('durable STAFF Telegram input sessions', () => {
  it('binds a GRAM reply to the exact prompt/item and delegates snapshot pricing to StaffService', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty', 'Введите вес');
    await s.flow.input(s.reply('742', 79), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    await s.flow.input(s.reply('742'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).toHaveBeenCalledExactlyOnceWith(6, 8,
      { status: 'PICKED', actualQty: 742 }, 7, { userId: 7, role: 'SELLER' });
    expect(s.session).toBeNull();
    await s.flow.input(s.reply('742', 80), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).toHaveBeenCalledTimes(1);
  });
  it('accepts integer PIECE quantity and rejects decimal input', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty', 'Введите количество');
    await s.flow.input(s.reply('1.5'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    await s.flow.input(s.reply('2'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).toHaveBeenCalledWith(6, 8, { status: 'PICKED', actualQty: 2 }, 7, { userId: 7, role: 'SELLER' });
  });
  it('expires a session without mutating an order', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty', 'Введите вес');
    s.setExpired();
    await s.flow.input(s.reply('742'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    expect(s.session).toBeNull();
  });
  it('cancels a pending session and ignores a stale reply', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty', 'Введите вес');
    await s.flow.cancel(3);
    await s.flow.input(s.reply('742', 80), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
  });
  it('creates an extra with exact integer kopecks and internal User.id only after confirmation', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title', 'Название');
    await s.flow.input(s.reply('Пакет'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('2'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('123,45'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('-'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.extra).not.toHaveBeenCalled();
    expect(s.session?.step).toBe('CONFIRM');
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'EXTRA', s.session?.confirmationCode ?? '')).toBe(true);
    expect(s.staff.extra).toHaveBeenCalledExactlyOnceWith(6, 7,
      { title: 'Пакет', quantity: 2, unitPrice: 12345, comment: '' }, undefined, undefined, { userId: 7, role: 'SELLER' });
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'EXTRA', '0123456789abcdef')).toBe(false);
  });
  it('requires reason and final confirmation for audited cancellation', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason', 'Причина');
    await s.flow.input(s.reply('Нет товара'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.cancel).not.toHaveBeenCalled();
    expect(await s.flow.finish(3, { userId: 7, role: 'ADMIN' }, 6, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(true);
    expect(s.staff.cancel).toHaveBeenCalledExactlyOnceWith(6, 7, 'ADMIN', 'Нет товара', { userId: 7, role: 'ADMIN' });
  });
  it('rejects confirmation for a different order and does not mutate', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason', 'Причина');
    await s.flow.input(s.reply('Ошибка'), 3, { userId: 7, role: 'SELLER' });
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 7, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(false);
    expect(s.staff.cancel).not.toHaveBeenCalled();
  });

  it('collects OTHER courier details and integer delivery price before domain mutation', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'DELIVERY', 'courierName', 'Курьер');
    await s.flow.input(s.reply('Иван'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('+79990000000'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('350,25'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('-'), 3, { userId: 7, role: 'SELLER' });
    await s.flow.input(s.reply('-'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.delivery).not.toHaveBeenCalled();
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'DELIVERY', s.session?.confirmationCode ?? '')).toBe(true);
    expect(s.staff.delivery).toHaveBeenCalledWith(6, expect.objectContaining({
      provider: 'OTHER', courierName: 'Иван', price: 35025,
    }), { userId: 7, role: 'SELLER' });
  });
  it('does not let a stale reply modify a newly selected order', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty', 'Вес');
    await s.flow.start(3, 123, 45, 7, 9, 'ITEM', 'qty', 'Вес');
    await s.flow.input(s.reply('742', 80), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    expect(s.session?.orderId).toBe(7);
  });
  it('rejects a stale confirmation button after a new flow for the same order', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason', 'Причина');
    await s.flow.input(s.reply('Первая причина'), 3, { userId: 7, role: 'SELLER' });
    const oldCode = s.session?.confirmationCode ?? '';
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason', 'Причина');
    await s.flow.input(s.reply('Новая причина'), 3, { userId: 7, role: 'SELLER' });
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'CANCEL', oldCode)).toBe(false);
    expect(s.staff.cancel).not.toHaveBeenCalled();
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(true);
    expect(s.staff.cancel).toHaveBeenCalledWith(6, 7, 'SELLER', 'Новая причина', { userId: 7, role: 'SELLER' });
  });
  it('rejects expired confirmation without calling StaffService', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason', 'Причина');
    await s.flow.input(s.reply('Ошибка'), 3, { userId: 7, role: 'SELLER' });
    s.setExpired();
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(false);
    expect(s.staff.cancel).not.toHaveBeenCalled();
  });
});
