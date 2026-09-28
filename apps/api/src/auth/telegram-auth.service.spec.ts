import { Logger } from '@nestjs/common';
import { signedInitData } from '../../test/telegram.fixture.js';
import type { DbService } from '../db/db.service.js';
import type { AuthService } from './auth.service.js';
import { TelegramAuthService } from './telegram-auth.service.js';

describe('Telegram Mini App HASH_INVALID logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('logs only field names and fixed diagnostic categories', () => {
    const botToken = '123456:fake-test-token';
    vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', botToken);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const params = new URLSearchParams(signedInitData(
      botToken,
      { id: 987654321, first_name: 'PrivateName' },
      { signature: 'PrivateSignature', query_id: 'PrivateQuery', chat_instance: 'PrivateChat' },
    ));
    params.set('PrivateKey', 'PrivateValue');
    params.set('hash', '0'.repeat(64));
    const service = new TelegramAuthService(
      {} as unknown as DbService,
      {} as unknown as AuthService,
    );

    expect(() => service.miniApp(params.toString())).toThrow('TELEGRAM_AUTH_INVALID');
    expect(warn.mock.calls).toEqual([
      ['Telegram Mini App failed: HASH_INVALID'],
      [
        'Telegram Mini App HASH_INVALID diagnostics: ' +
        'MINIAPP_FIELD_NAMES=["auth_date","chat_instance","hash","query_id","signature","unknown","user"]' +
        ' HAS_SIGNATURE=yes HMAC_CURRENT_MATCH=no HMAC_WITHOUT_SIGNATURE_MATCH=no' +
        ' ED25519_VALID=no AUTH_DATE_BUCKET=fresh',
      ],
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const privateValue of [
      botToken, '987654321', 'PrivateName', 'PrivateSignature', 'PrivateQuery',
      'PrivateChat', 'PrivateKey', 'PrivateValue', params.toString(),
    ])
      expect(logged).not.toContain(privateValue);
  });
});
