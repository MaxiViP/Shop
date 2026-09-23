import type { DbService } from '../db/db.service.js';
import { StaffLinkService } from './staff-link.service.js';

function setup(role: 'SELLER' | 'ADMIN' | 'USER' = 'SELLER') {
  const user = { findUnique: vi.fn(async () => ({ role })) };
  const upsertCode = vi.fn(async () => ({}));
  let consumed = false;
  let expiry = new Date(Date.now() + 60_000);
  const findCode = vi.fn(async () => consumed ? null : {
    userId: 7, expiresAt: expiry, user: { role },
  });
  const deleteCode = vi.fn(async () => {
    if (consumed) return { count: 0 };
    consumed = true;
    return { count: 1 };
  });
  const findIdentity = vi.fn(async () => null as { userId: number } | null);
  const upsertIdentity = vi.fn(async () => ({}));
  const tx = {
    staffTelegramLinkCode: { findUnique: findCode, deleteMany: deleteCode },
    staffTelegramIdentity: { findUnique: findIdentity, upsert: upsertIdentity },
  };
  const db = {
    user, staffTelegramLinkCode: { upsert: upsertCode },
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<boolean>) => operation(tx)),
  } as unknown as DbService;
  const links = new StaffLinkService(db);
  return { links, upsertCode, findCode, deleteCode, findIdentity, upsertIdentity,
    expire: () => { expiry = new Date(Date.now() - 1); } };
}

describe('STAFF one-time Telegram linking', () => {
  it.each(['SELLER', 'ADMIN'] as const)('issues a short-lived hash-only code for %s', async role => {
    const s = setup(role);
    const result = await s.links.createCode(7);
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const data = s.upsertCode.mock.calls[0]?.[0] as { create: { codeHash: string } };
    expect(data.create.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.create.codeHash).not.toContain(result.code);
  });
  it('rejects USER role before issuing a code', async () => {
    const s = setup('USER');
    await expect(s.links.createCode(7)).rejects.toThrow();
    expect(s.upsertCode).not.toHaveBeenCalled();
  });
  it('links a verified private Telegram actor once and rejects used/expired codes', async () => {
    const s = setup();
    expect(await s.links.link(123, 'A'.repeat(22))).toBe(true);
    expect(s.upsertIdentity).toHaveBeenCalledWith(expect.objectContaining({
      where: { telegramUserId: 123n },
      create: expect.objectContaining({ userId: 7, telegramUserId: 123n }),
    }));
    expect(await s.links.link(123, 'A'.repeat(22))).toBe(false);
    const expired = setup();
    expired.expire();
    expect(await expired.links.link(123, 'A'.repeat(22))).toBe(false);
    expect(expired.upsertIdentity).not.toHaveBeenCalled();
  });
  it('rejects invalid IDs, codes, user roles and cross-account relinking', async () => {
    const s = setup();
    expect(await s.links.link(0, 'A'.repeat(22))).toBe(false);
    expect(await s.links.link(123, 'bad')).toBe(false);
    s.findIdentity.mockResolvedValueOnce({ userId: 8 });
    expect(await s.links.link(123, 'A'.repeat(22))).toBe(false);
    expect(s.upsertIdentity).not.toHaveBeenCalled();
    const user = setup('USER');
    expect(await user.links.link(123, 'A'.repeat(22))).toBe(false);
  });
});
