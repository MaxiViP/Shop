import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import type { StaffTelegramSession } from '../db/gen/client.js';
import type { DbService } from '../db/db.service.js';
import type { StaffService } from '../staff/staff.service.js';
import type { TelegramService } from './telegram.service.js';
import { StaffBotFlowService } from './staff-bot-flow.service.js';

type Session = StaffTelegramSession;
type Where = Partial<Pick<Session, 'identityId' | 'step' | 'action' | 'orderId' |
  'itemId' | 'promptMessageId' | 'confirmationCode' | 'updatedAt'>> & { expiresAt?: { gt: Date } };
function setup() {
  let session: Session | null = null;
  let nextPrompt = 80;
  let tick = Date.now();
  const matches = (where: Where) => session !== null && Object.entries(where).every(([key, value]) => {
    if (key === 'expiresAt') return session!.expiresAt > (value as { gt: Date }).gt;
    const actual = session![key as keyof Session];
    return value instanceof Date && actual instanceof Date ? value.getTime() === actual.getTime() : value === actual;
  });
  const getSession = vi.fn(async ({ where }: { where: { identityId: number } }) =>
    session?.identityId === where.identityId ? { ...session } : null);
  const createMany = vi.fn(async ({ data }: { data: Omit<Session, 'createdAt' | 'updatedAt'> }) => {
    if (session) return { count: 0 };
    session = { ...data, createdAt: new Date(), updatedAt: new Date(++tick) };
    return { count: 1 };
  });
  const updateMany = vi.fn(async ({ where, data }: { where: Where; data: Partial<Session> }) => {
    if (!matches(where)) return { count: 0 };
    session = { ...session!, ...data, updatedAt: new Date(++tick) };
    return { count: 1 };
  });
  const deleteMany = vi.fn(async ({ where }: { where: Where }) => {
    if (!matches(where)) return { count: 0 };
    session = null;
    return { count: 1 };
  });
  const db = { staffTelegramSession: { findUnique: getSession, createMany, updateMany, deleteMany } } as unknown as DbService;
  const staff = {
    get: vi.fn(async () => ({ status: 'ASSEMBLING',
      items: [{ id: 8, status: 'PENDING', unit: 'GRAM' }] })),
    item: vi.fn(async () => ({})), extra: vi.fn(async () => ({})),
    delivery: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})),
  };
  const telegram = {
    promptStaff: vi.fn<() => Promise<number | null>>(async () => nextPrompt++),
    sendStaff: vi.fn(async () => {}),
    editStaff: vi.fn(async () => {}),
  };
  const restart = () => new StaffBotFlowService(db, staff as unknown as StaffService,
    telegram as unknown as TelegramService);
  const flow = restart();
  const reply = (text: string, promptId = session?.promptMessageId ?? 80) => ({
    message_id: 100, from: { id: 123, is_bot: false },
    chat: { id: 123, type: 'private' }, text,
    reply_to_message: { message_id: promptId },
  });
  return { flow, staff, telegram, reply, restart, updateMany, deleteMany, get session() { return session; },
    setExpired: () => { if (session) session.expiresAt = new Date(Date.now() - 1); } };
}

describe('durable STAFF Telegram input sessions', () => {
  it('binds a GRAM reply to the exact prompt/item and delegates snapshot pricing to StaffService', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
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
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
    await s.flow.input(s.reply('1.5'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    await s.flow.input(s.reply('2'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).toHaveBeenCalledWith(6, 8, { status: 'PICKED', actualQty: 2 }, 7, { userId: 7, role: 'SELLER' });
  });
  it('expires a session without mutating an order', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
    s.setExpired();
    await s.flow.input(s.reply('742'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    expect(s.session).toBeNull();
  });
  it('cancels a pending session and ignores a stale reply', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
    await s.flow.cancel(3);
    await s.flow.input(s.reply('742', 80), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
  });
  it('creates an extra with exact integer kopecks and internal User.id only after confirmation', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
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
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason');
    await s.flow.input(s.reply('Нет товара'), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.cancel).not.toHaveBeenCalled();
    expect(await s.flow.finish(3, { userId: 7, role: 'ADMIN' }, 6, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(true);
    expect(s.staff.cancel).toHaveBeenCalledExactlyOnceWith(6, 7, 'ADMIN', 'Нет товара', { userId: 7, role: 'ADMIN' });
  });
  it('rejects confirmation for a different order and does not mutate', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason');
    await s.flow.input(s.reply('Ошибка'), 3, { userId: 7, role: 'SELLER' });
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 7, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(false);
    expect(s.staff.cancel).not.toHaveBeenCalled();
  });

  it('collects OTHER courier details and integer delivery price before domain mutation', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'DELIVERY', 'courierName');
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
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
    s.staff.get.mockResolvedValueOnce({ status: 'ASSEMBLING', items: [{ id: 9, status: 'PENDING', unit: 'GRAM' }] });
    await s.flow.start(3, 123, 45, 7, 9, 'ITEM', 'qty');
    await s.flow.input(s.reply('742', 80), 3, { userId: 7, role: 'SELLER' });
    expect(s.staff.item).not.toHaveBeenCalled();
    expect(s.session?.orderId).toBe(7);
  });
  it('rejects a stale confirmation button after a new flow for the same order', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason');
    await s.flow.input(s.reply('Первая причина'), 3, { userId: 7, role: 'SELLER' });
    const oldCode = s.session?.confirmationCode ?? '';
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason');
    await s.flow.input(s.reply('Новая причина'), 3, { userId: 7, role: 'SELLER' });
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'CANCEL', oldCode)).toBe(false);
    expect(s.staff.cancel).not.toHaveBeenCalled();
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(true);
    expect(s.staff.cancel).toHaveBeenCalledWith(6, 7, 'SELLER', 'Новая причина', { userId: 7, role: 'SELLER' });
  });
  it('rejects expired confirmation without calling StaffService', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'CANCEL', 'reason');
    await s.flow.input(s.reply('Ошибка'), 3, { userId: 7, role: 'SELLER' });
    s.setExpired();
    expect(await s.flow.finish(3, { userId: 7, role: 'SELLER' }, 6, 'CANCEL', s.session?.confirmationCode ?? '')).toBe(false);
    expect(s.staff.cancel).not.toHaveBeenCalled();
  });
});

const actor = { userId: 7, role: 'SELLER' as const };
const extraInputs = ['сервис', '2', '123,45', '-'];
async function extraConfirmation(s: ReturnType<typeof setup>) {
  await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
  for (const value of extraInputs) await s.flow.input(s.reply(value), 3, actor);
  return s.session!.confirmationCode!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('STAFF prompt delivery uncertainty and explicit resume', () => {
  it('persists EXTRA before the first unknown send and resumes after process restart', async () => {
    const s = setup();
    s.telegram.promptStaff.mockImplementationOnce(async () => {
      expect(s.session).toMatchObject({ action: 'EXTRA', step: 'title', promptMessageId: null });
      return null;
    });
    expect(await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title')).toBe(false);
    await s.flow.input(s.reply('сервис'), 3, actor);
    expect(s.session?.step).toBe('title');
    expect(s.staff.extra).not.toHaveBeenCalled();
    const restarted = s.restart();
    await restarted.resume(3, 123);
    expect(s.session?.promptMessageId).toBe(80);
    await restarted.input(s.reply('сервис'), 3, actor);
    expect(s.session).toMatchObject({ step: 'quantity', payload: { title: 'сервис' } });
  });

  it.each([
    [0, 'quantity', 'количество'],
    [1, 'price', 'цену'],
    [2, 'comment', 'Комментарий'],
  ])('retains EXTRA input when the next prompt after input %i is unknown', async (index, step, hint) => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    const last = Number(index);
    for (let i = 0; i < last; i++) await s.flow.input(s.reply(extraInputs[i]!), 3, actor);
    const oldPrompt = s.session!.promptMessageId!;
    s.telegram.promptStaff.mockResolvedValueOnce(null);
    await s.flow.input(s.reply(extraInputs[last]!), 3, actor);
    const pending = s.session!;
    expect(pending).toMatchObject({ step, promptMessageId: null, payload: { title: 'сервис' } });
    await s.flow.input(s.reply('999', oldPrompt), 3, actor);
    await s.flow.input(s.reply('999', 900), 3, actor); // Unacknowledged prompt actually reached Telegram.
    expect(s.session).toEqual(pending);
    await s.restart().resume(3, 123);
    expect(s.telegram.promptStaff).toHaveBeenLastCalledWith(123, expect.stringContaining(String(hint)));
    await s.flow.input(s.reply(extraInputs[last + 1]!), 3, actor);
    expect(s.session?.step).not.toBe(step);
    expect(s.staff.extra).not.toHaveBeenCalled();
  });

  it('revokes the previously bound prompt on /resume', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    const old = s.reply('stale');
    await s.flow.resume(3, 123);
    const current = s.session!;
    await s.flow.input(old, 3, actor);
    expect(s.session).toEqual(current);
    await s.flow.input(s.reply('сервис'), 3, actor);
    expect(s.session?.payload).toMatchObject({ title: 'сервис' });
  });

  it('consumes concurrent duplicate text replies only once', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    const reply = s.reply('сервис');
    await Promise.all([s.flow.input(reply, 3, actor), s.flow.input(reply, 3, actor)]);
    expect(s.session).toMatchObject({ step: 'quantity', payload: { title: 'сервис' } });
    expect(s.telegram.promptStaff).toHaveBeenCalledTimes(2);
  });

  it.each(['cancel', 'resume', 'start'] as const)('fences a delayed sendMessage result after %s', async kind => {
    const s = setup(), sent = deferred<number | null>(), sending = deferred<void>();
    s.telegram.promptStaff.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const start = s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    await sending.promise;
    if (kind === 'cancel') await s.flow.cancel(3);
    if (kind === 'resume') await s.flow.resume(3, 123);
    if (kind === 'start') await s.flow.start(3, 123, 44, 7, null, 'CANCEL', 'reason');
    const current = s.session;
    sent.resolve(700);
    expect(await start).toBe(false);
    expect(s.session).toEqual(current);
    await s.flow.input(s.reply('old reply', 700), 3, actor);
    expect(s.session).toEqual(current);
    expect(s.staff.extra).not.toHaveBeenCalled();
    expect(s.staff.cancel).not.toHaveBeenCalled();
  });

  it.each(['bound', 'unknown', 'confirmation'] as const)('/cancel removes a %s flow', async state => {
    const s = setup();
    if (state === 'confirmation') await extraConfirmation(s);
    else {
      if (state === 'unknown') s.telegram.promptStaff.mockResolvedValueOnce(null);
      await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    }
    expect(await s.flow.cancel(3)).toBe(true);
    expect(s.session).toBeNull();
    await s.flow.input(s.reply('stale'), 3, actor);
    expect(s.staff.extra).not.toHaveBeenCalled();
  });

  it('/resume with no session or expired session does not send a prompt', async () => {
    const s = setup();
    await s.flow.resume(3, 123);
    expect(s.telegram.sendStaff).toHaveBeenLastCalledWith(123, expect.stringContaining('Нет незавершённого'));
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    s.setExpired();
    await s.flow.resume(3, 123);
    expect(s.session).toBeNull();
    expect(s.telegram.promptStaff).toHaveBeenCalledTimes(1);
    expect(s.telegram.sendStaff).toHaveBeenLastCalledWith(123, expect.stringContaining('истекло'));
  });

  it('rotates confirmation buttons on resume without a domain call', async () => {
    const s = setup();
    const oldCode = await extraConfirmation(s);
    await s.flow.resume(3, 123);
    expect(s.session?.confirmationCode).not.toBe(oldCode);
    expect(await s.flow.finish(3, actor, 6, 'EXTRA', oldCode)).toBe(false);
    expect(s.staff.extra).not.toHaveBeenCalled();
    expect(s.telegram.editStaff).toHaveBeenLastCalledWith(123, 44, expect.stringContaining('сервис'), expect.any(Object));
  });

  it('does not allow another identity to resume, cancel or input the session', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, null, 'EXTRA', 'title');
    const current = s.session;
    await s.flow.resume(4, 456);
    await s.flow.cancel(4);
    await s.flow.input(s.reply('foreign'), 4, actor);
    expect(s.session).toEqual(current);
  });

  it('keeps a saved confirmation after a failed Telegram edit', async () => {
    const s = setup();
    s.telegram.editStaff.mockRejectedValueOnce(new Error('synthetic network failure'));
    await extraConfirmation(s);
    expect(s.session).toMatchObject({ step: 'CONFIRM', payload: { title: 'сервис', unitPrice: 12345 } });
    await s.restart().resume(3, 123);
    expect(s.telegram.editStaff).toHaveBeenCalledTimes(2);
  });

  it.each(['ITEM', 'CANCEL', 'DELIVERY'] as const)('resumes unknown initial %s prompt', async action => {
    const s = setup();
    s.telegram.promptStaff.mockResolvedValueOnce(null);
    const step = action === 'ITEM' ? 'qty' : action === 'CANCEL' ? 'reason' : 'courierName';
    await s.flow.start(3, 123, 44, 6, action === 'ITEM' ? 8 : null, action, step);
    expect(s.session).toMatchObject({ action, step, promptMessageId: null });
    await s.restart().resume(3, 123);
    await s.flow.input(s.reply(action === 'ITEM' ? '742' : 'Иван'), 3, actor);
    if (action === 'ITEM') expect(s.staff.item).toHaveBeenCalledTimes(1);
    else expect(s.session?.step).toBe(action === 'CANCEL' ? 'CONFIRM' : 'courierPhone');
  });
});

describe('STAFF domain claim and outcome fencing', () => {
  it('allows only one concurrent confirmation to call the domain', async () => {
    const s = setup(), code = await extraConfirmation(s);
    const result = await Promise.all([s.flow.finish(3, actor, 6, 'EXTRA', code),
      s.flow.finish(3, actor, 6, 'EXTRA', code)]);
    expect(result.sort()).toEqual([false, true]);
    expect(s.staff.extra).toHaveBeenCalledTimes(1);
    expect(s.session).toBeNull();
  });

  it.each([
    new BadRequestException('Максимальная цена услуги — 5000 ₽.'),
    new ConflictException('Stale extra version'),
  ])('retains confirmation data after a deterministic business rejection', async error => {
    const s = setup(), code = await extraConfirmation(s);
    s.staff.extra.mockRejectedValueOnce(error);
    await expect(s.flow.finish(3, actor, 6, 'EXTRA', code)).rejects.toBe(error);
    expect(s.session).toMatchObject({ step: 'CONFIRM', payload: { title: 'сервис', unitPrice: 12345 } });
    expect(s.session?.confirmationCode).not.toBe(code);
    expect(await s.flow.finish(3, actor, 6, 'EXTRA', code)).toBe(false);
    await s.restart().resume(3, 123);
    expect(await s.flow.finish(3, actor, 6, 'EXTRA', s.session!.confirmationCode!)).toBe(true);
    expect(s.session).toBeNull();
  });

  it('restores ITEM input unbound on a definite domain rejection', async () => {
    const s = setup();
    await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
    s.staff.item.mockRejectedValueOnce(new ConflictException('Item changed'));
    const original = s.reply('742');
    await s.flow.input(original, 3, actor);
    expect(s.session).toMatchObject({ step: 'qty', promptMessageId: null });
    await s.flow.input(original, 3, actor);
    expect(s.staff.item).toHaveBeenCalledTimes(1);
    await s.flow.resume(3, 123);
    await s.flow.input(s.reply('745'), 3, actor);
    expect(s.staff.item).toHaveBeenCalledTimes(2);
    expect(s.session).toBeNull();
  });

  it('does not abandon or replay an uncertain DB mutation, even after restart/expiry', async () => {
    const s = setup(), code = await extraConfirmation(s);
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    s.staff.extra.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_DETAILS'));
    try {
      await expect(s.flow.finish(3, actor, 6, 'EXTRA', code)).rejects.toThrow();
      expect(s.session?.step).toBe('COMMITTING');
      s.setExpired();
      const restarted = s.restart();
      await restarted.resume(3, 123);
      expect(await restarted.cancel(3)).toBe(false);
      expect(await restarted.start(3, 123, 44, 6, null, 'EXTRA', 'title')).toBe(false);
      expect(await restarted.finish(3, actor, 6, 'EXTRA', code)).toBe(false);
      expect(s.staff.extra).toHaveBeenCalledTimes(1);
      expect(s.session?.step).toBe('COMMITTING');
      expect(logger).toHaveBeenCalledWith('Staff Telegram mutation outcome unknown');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_PROVIDER_DETAILS');
    } finally { logger.mockRestore(); }
  });

  it('does not report a failed mutation when post-commit session cleanup fails', async () => {
    const s = setup(), code = await extraConfirmation(s);
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    s.deleteMany.mockRejectedValueOnce(new Error('Synthetic cleanup failure'));
    try {
      expect(await s.flow.finish(3, actor, 6, 'EXTRA', code)).toBe(true);
      expect(s.session?.step).toBe('COMMITTING');
      expect(await s.flow.finish(3, actor, 6, 'EXTRA', code)).toBe(false);
      expect(s.staff.extra).toHaveBeenCalledTimes(1);
    } finally { logger.mockRestore(); }
  });

  it('cannot cancel or overwrite a live COMMITTING operation', async () => {
    const s = setup(), code = await extraConfirmation(s);
    const running = deferred<void>(), result = deferred<object>();
    s.staff.extra.mockImplementationOnce(() => { running.resolve(); return result.promise; });
    const first = s.flow.finish(3, actor, 6, 'EXTRA', code);
    await running.promise;
    try {
      expect(await s.flow.cancel(3)).toBe(false);
      expect(await s.flow.start(3, 123, 44, 7, null, 'EXTRA', 'title')).toBe(false);
      await s.flow.resume(3, 123);
      expect(await s.flow.finish(3, actor, 6, 'EXTRA', code)).toBe(false);
      expect(s.staff.extra).toHaveBeenCalledTimes(1);
    } finally { result.resolve({}); }
    expect(await first).toBe(true);
    expect(s.session).toBeNull();
  });
});

it('invalidates an ITEM prompt if the item changed before the claim', async () => {
  const s = setup();
  await s.flow.start(3, 123, 44, 6, 8, 'ITEM', 'qty');
  const old = s.reply('742');
  s.staff.get.mockResolvedValueOnce({ status: 'ASSEMBLING', items: [{ id: 8, status: 'PICKED', unit: 'GRAM' }] });
  await s.flow.input(old, 3, actor);
  expect(s.session).toMatchObject({ step: 'qty', promptMessageId: null });
  await s.flow.input(old, 3, actor);
  expect(s.staff.item).not.toHaveBeenCalled();
});
