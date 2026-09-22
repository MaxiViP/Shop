import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TelegramAuthCtrl } from './telegram-auth.ctrl.js';
import type { TelegramAuthService } from './telegram-auth.service.js';
import type { TelegramOidcService } from './telegram-oidc.service.js';

describe('Telegram callback safe stage diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const proof = {
      profile: { id: 123, username: 'private-user' },
      tokenHash: 'private-proof',
      expiresAt: new Date(),
    };
    const telegram = {
      login: vi.fn().mockResolvedValue({ token: 'private-session', user: {} }),
    };
    const oidc = {
      available: true,
      callback: vi.fn().mockResolvedValue(proof),
      destination: (failed: boolean) =>
        failed
          ? 'https://shop.example/telegram?error=login'
          : 'https://shop.example/profile',
    };
    const response = {
      clearCookie: vi.fn(),
      cookie: vi.fn(),
      redirect: vi.fn(),
    };
    const request = {
      cookies: { sid: 'private-cookie', 'telegram-flow': 'private-flow' },
    };
    const controller = new TelegramAuthCtrl(
      telegram as unknown as TelegramAuthService,
      oidc as unknown as TelegramOidcService,
    );
    const run = (
      query: Record<string, unknown> = {
        code: 'private-code',
        state: 'private-state',
      },
    ) =>
      controller.callback(
        query,
        request as unknown as Request,
        response as unknown as Response,
      );
    return { warn, oidc, telegram, response, run };
  }

  it('logs only FLOW_INVALID for malformed callback query', async () => {
    const s = setup();
    await s.run({ error: 'provider details containing secrets' });
    expect(s.warn.mock.calls).toEqual([
      ['Telegram OIDC failed: OIDC_FLOW_INVALID'],
    ]);
    expect(s.oidc.callback).not.toHaveBeenCalled();
    expect(s.telegram.login).not.toHaveBeenCalled();
    expect(s.response.redirect).toHaveBeenCalledWith(
      303,
      'https://shop.example/telegram?error=login',
    );
  });
  it('does not duplicate service diagnostics or expose caught provider error', async () => {
    const s = setup();
    s.oidc.callback.mockRejectedValue(
      new Error('private-token and provider details'),
    );
    await s.run();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.telegram.login).not.toHaveBeenCalled();
    expect(s.response.redirect).toHaveBeenCalledWith(
      303,
      'https://shop.example/telegram?error=login',
    );
  });
  it('distinguishes identity/session transaction failure without logging database details', async () => {
    const s = setup();
    s.telegram.login.mockRejectedValue(
      new Error('private-user private-proof database query'),
    );
    await s.run();
    expect(s.warn.mock.calls).toEqual([
      ['Telegram OIDC failed: TELEGRAM_IDENTITY_LOGIN_FAILED'],
    ]);
    expect(s.response.cookie).not.toHaveBeenCalled();
    expect(s.response.redirect).toHaveBeenCalledWith(
      303,
      'https://shop.example/telegram?error=login',
    );
  });
  it('does not log successful auth or expose sensitive values in redirect', async () => {
    const s = setup();
    await s.run();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.response.redirect).toHaveBeenCalledWith(
      303,
      'https://shop.example/profile',
    );
  });
});
