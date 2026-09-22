import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AdminGuard } from './admin.guard.js';
import { AdminLoginGuard } from './admin-login.guard.js';
import { AuthService } from './auth.service.js';
import type { DbService } from '../db/db.service.js';
import { allowedOrigin } from './admin.config.js';

function context(role = 'ADMIN', origin?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { role },
        cookies: { sid: 'fixture' },
        headers: { origin },
        method: 'POST',
        socket: { remoteAddress: '127.0.0.1' },
      }),
    }),
  } as unknown as ExecutionContext;
}
describe('Admin security', () => {
  it('production CORS only permits configured exact origins', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGINS', 'https://shop.example');
    expect(allowedOrigin('https://shop.example')).toBe(true);
    expect(allowedOrigin('https://shop.example.evil.test')).toBe(false);
    expect(allowedOrigin('http://127.0.0.1:3003')).toBe(false);
  });
  beforeEach(() => {
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(['USER', 'SELLER'] as const)(
    'denies %s despite forged request role',
    async (role) => {
      const auth = {
        me: vi.fn().mockResolvedValue({ role, phone: '+79990000001' }),
      };
      await expect(
        new AdminGuard(auth as unknown as AuthService).canActivate(context()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it('allows the configured ADMIN resolved from session', async () => {
    const auth = {
      me: vi.fn().mockResolvedValue({ role: 'ADMIN', phone: '+79990000001' }),
    };
    await expect(
      new AdminGuard(auth as unknown as AuthService).canActivate(context()),
    ).resolves.toBe(true);
  });
  it('rejects stale ADMIN with another phone and unauthenticated access', async () => {
    for (const user of [null, { role: 'ADMIN', phone: '+79990000002' }]) {
      const auth = { me: vi.fn().mockResolvedValue(user) };
      await expect(
        new AdminGuard(auth as unknown as AuthService).canActivate(context()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it('does not treat missing admin config and null phone as matching credentials', async () => {
    vi.stubEnv('ADMIN_PHONE', '');
    const auth = {
      me: vi.fn().mockResolvedValue({ role: 'ADMIN', phone: null }),
    };
    await expect(
      new AdminGuard(auth as unknown as AuthService).canActivate(context()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('rejects invalid credentials with identical error', async () => {
    vi.stubEnv('ADMIN_PASSWORD', randomBytes(32).toString('hex'));
    const auth = new AuthService({} as DbService);
    for (const phone of ['bad', '+79990000001', '+79990000002'])
      await expect(
        auth.adminLogin(phone, randomBytes(32).toString('hex')),
      ).rejects.toThrow('Неверные данные для входа');
  });
  it('fails closed without credentials', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    await expect(
      new AuthService({} as DbService).adminLogin('+79990000001', ''),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('creates ADMIN and normal hashed session transactionally', async () => {
    const password = randomBytes(32).toString('hex');
    vi.stubEnv('ADMIN_PASSWORD', password);
    const tx = {
      $executeRaw: vi.fn(),
      session: { deleteMany: vi.fn(), create: vi.fn() },
      user: {
        updateMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 1, role: 'USER' }),
        upsert: vi
          .fn()
          .mockResolvedValue({ id: 1, phone: '+79990000001', role: 'ADMIN' }),
      },
    };
    const db = {
      $transaction: vi
        .fn()
        .mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    const result = await new AuthService(db as unknown as DbService).adminLogin(
      '+79990000001',
      password,
    );
    expect(result.user.role).toBe('ADMIN');
    expect(result.token.length).toBe(64);
    expect(tx.session.create.mock.calls[0]?.[0].data.tokenHash).not.toBe(
      result.token,
    );
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1 },
    });
    expect(JSON.stringify(tx.user.upsert.mock.calls)).not.toContain(password);
  });
  it('blocks OTP for ADMIN', async () => {
    const db = {
      user: { findUnique: vi.fn().mockResolvedValue({ role: 'ADMIN' }) },
    };
    await expect(
      new AuthService(db as unknown as DbService).login(
        '+79990000001',
        '123456',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rate limits before validation and rejects untrusted origins', () => {
    const guard = new AdminLoginGuard();
    for (let i = 0; i < 5; i++) expect(guard.canActivate(context())).toBe(true);
    expect(() => guard.canActivate(context())).toThrow('Слишком много попыток');
    expect(() =>
      new AdminLoginGuard().canActivate(
        context('ADMIN', 'https://evil.example'),
      ),
    ).toThrow(ForbiddenException);
  });
});
