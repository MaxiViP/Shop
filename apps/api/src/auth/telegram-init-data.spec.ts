import { randomBytes } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { signedInitData } from '../../test/telegram.fixture.js';
import { verifyInitData } from './telegram-init-data.js';

describe('Telegram Mini App signature', () => {
  const token = randomBytes(32).toString('hex');
  it('validates decoded, sorted fields including the optional signature field', () => {
    const raw = signedInitData(
      token,
      { id: 123, first_name: 'Имя & +', username: 'name' },
      { signature: 'signed-extra' },
    );
    expect(verifyInitData(raw, token).profile).toMatchObject({
      id: 123,
      first_name: 'Имя & +',
    });
    const reversed = new URLSearchParams(
      [...new URLSearchParams(raw)].reverse(),
    ).toString();
    expect(verifyInitData(reversed, token).tokenHash).toBe(
      verifyInitData(raw, token).tokenHash,
    );
  });
  it.each([-301, 120, 10_000_000])(
    'rejects expired/future auth_date: %s',
    (offset) => {
      const raw = signedInitData(
        token,
        { id: 1 },
        { auth_date: String(Math.floor(Date.now() / 1000) + offset) },
      );
      expect(() => verifyInitData(raw, token)).toThrow(UnauthorizedException);
    },
  );
  it('rejects tampered identity, username, hash and wrong bot', () => {
    const raw = signedInitData(token, { id: 123, username: 'original' });
    for (const [key, value] of [
      ['user', '{"id":456}'],
      ['user', '{"id":123,"username":"admin"}'],
      ['hash', '0'.repeat(64)],
    ]) {
      const changed = new URLSearchParams(raw);
      changed.set(key!, value!);
      expect(() => verifyInitData(changed.toString(), token)).toThrow(
        'TELEGRAM_AUTH_INVALID',
      );
    }
    expect(() => verifyInitData(raw, randomBytes(32).toString('hex'))).toThrow(
      'TELEGRAM_AUTH_INVALID',
    );
  });
  it.each(['', 'user={}', 'hash=bad', 'x'.repeat(16385)])(
    'rejects malformed input',
    (raw) => {
      expect(() => verifyInitData(raw, token)).toThrow(UnauthorizedException);
    },
  );
  it('rejects duplicate keys, invalid user JSON, bots and unsafe IDs', () => {
    const raw = signedInitData(token);
    expect(() => verifyInitData(raw + '&auth_date=1', token)).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      verifyInitData(signedInitData(token, { id: 1 }, { user: '{' }), token),
    ).toThrow(UnauthorizedException);
    for (const user of [
      { id: 1, is_bot: true },
      { id: -1 },
      { id: '123' },
      { id: 2 ** 53 },
    ])
      expect(() => verifyInitData(signedInitData(token, user), token)).toThrow(
        UnauthorizedException,
      );
    expect(() => verifyInitData(raw, '')).toThrow(UnauthorizedException);
  });
});
