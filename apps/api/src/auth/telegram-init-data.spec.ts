import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { signedInitData } from '../../test/telegram.fixture.js';
import {
  ed25519SignatureMatches,
  miniAppHashDiagnostics,
  verifyInitData,
  type MiniAppFailureStage,
  type MiniAppHashDiagnostics,
} from './telegram-init-data.js';

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
  it('accepts a signed HTTPS avatar without treating Mini App phone fields as OIDC metadata', () => {
    const proof = verifyInitData(signedInitData(token, {
      id: 123,
      photo_url: 'https://example.test/avatar.webp',
      phone_number: '+79991234567',
      phone_number_verified: true,
    }), token);
    expect(proof.profile.photo_url).toBe('https://example.test/avatar.webp');
    expect(proof.phone).toBeUndefined();
  });
  it.each(['http://example.test/avatar', 'not-a-url', 'data:image/png;base64,a', 'https://user:pass@example.test/avatar'])(
    'rejects unsafe signed Mini App avatar variant %#', (photo_url) => {
      expect(() => verifyInitData(signedInitData(token, { id: 123, photo_url }), token))
        .toThrow('TELEGRAM_AUTH_INVALID');
    },
  );
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
  it('classifies Mini App failures with static stage codes only', () => {
    const valid = signedInitData(token, { id: 123, first_name: 'PrivateName' });
    const changed = new URLSearchParams(valid);
    changed.set('hash', '0'.repeat(64));
    const expired = signedInitData(token, { id: 123 }, {
      auth_date: String(Math.floor(Date.now() / 1000) - 301),
    });
    const cases: Array<[string, string, MiniAppFailureStage]> = [
      ['', token, 'INIT_DATA_MISSING'],
      [valid, '', 'BOT_TOKEN_UNAVAILABLE'],
      ['x'.repeat(16385), token, 'INIT_DATA_INVALID'],
      [changed.toString(), token, 'HASH_INVALID'],
      [expired, token, 'AUTH_DATE_INVALID_OR_EXPIRED'],
      [signedInitData(token, { id: '123' }), token, 'PROFILE_INVALID'],
    ];
    for (const [initData, bot, expected] of cases) {
      const stages: MiniAppFailureStage[] = [];
      expect(() => verifyInitData(initData, bot, Date.now(), stage => stages.push(stage)))
        .toThrow('TELEGRAM_AUTH_INVALID');
      expect(stages).toEqual([expected]);
      expect(JSON.stringify(stages)).not.toContain('PrivateName');
      expect(JSON.stringify(stages)).not.toContain(token);
    }
    const stages: MiniAppFailureStage[] = [];
    verifyInitData(valid, token, Date.now(), stage => stages.push(stage));
    expect(stages).toEqual([]);
  });

  it('keeps the current HMAC valid with signature included and emits no failure diagnostics', () => {
    const raw = signedInitData(token, { id: 123 }, { signature: 'signed-extra' });
    const params = new URLSearchParams(raw);
    const diagnostics = miniAppHashDiagnostics(params, params.get('hash') ?? '', token, Date.now());
    expect(diagnostics).toMatchObject({
      fieldNames: ['auth_date', 'hash', 'signature', 'user'],
      hasSignature: true,
      hmacCurrentMatch: true,
      hmacWithoutSignatureMatch: false,
      ed25519Valid: false,
      authDateBucket: 'fresh',
    });
    const onInvalid = vi.fn();
    expect(verifyInitData(raw, token, Date.now(), onInvalid).profile.id).toBe(123);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('reports only a diagnostic match when the hash excludes signature, but still rejects', () => {
    const params = new URLSearchParams(signedInitData(token, { id: 123 }));
    params.set('signature', 'signed-extra');
    const calls: Array<[MiniAppFailureStage, MiniAppHashDiagnostics | undefined]> = [];
    expect(() => verifyInitData(params.toString(), token, Date.now(),
      (stage, diagnostics) => calls.push([stage, diagnostics])))
      .toThrow('TELEGRAM_AUTH_INVALID');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('HASH_INVALID');
    expect(calls[0]?.[1]).toMatchObject({
      hasSignature: true,
      hmacCurrentMatch: false,
      hmacWithoutSignatureMatch: true,
      ed25519Valid: false,
      authDateBucket: 'fresh',
    });
  });

  it('reports invalid HMAC without signature and buckets auth_date using the unchanged TTL', () => {
    const now = Date.now();
    const params = new URLSearchParams(signedInitData(token, { id: 123 }));
    params.set('hash', '0'.repeat(64));
    expect(miniAppHashDiagnostics(params, params.get('hash') ?? '', token, now))
      .toMatchObject({
        hasSignature: false,
        hmacCurrentMatch: false,
        hmacWithoutSignatureMatch: false,
        ed25519Valid: false,
        authDateBucket: 'fresh',
      });
    for (const [date, bucket] of [
      [String(Math.floor(now / 1000) - 301), 'old'],
      [String(Math.floor(now / 1000) + 120), 'future'],
      ['bad', 'invalid'],
    ] as const) {
      params.set('auth_date', date);
      expect(miniAppHashDiagnostics(params, params.get('hash') ?? '', token, now)
        .authDateBucket).toBe(bucket);
    }
  });

  it('verifies a reproducible Ed25519 third-party fixture and rejects bad or missing signatures', () => {
    const botToken = '123456:test-token';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }))
      .subarray(-32).toString('hex');
    const params = new URLSearchParams(signedInitData(botToken, { id: 123 }));
    params.delete('hash');
    params.sort();
    const check = [...params].map(([key, value]) => key + '=' + value).join('\n');
    const signature = sign(null, Buffer.from('123456:WebAppData\n' + check), privateKey)
      .toString('base64url');
    expect(ed25519SignatureMatches(params, botToken, publicKeyHex)).toBe(false);
    params.set('signature', signature);
    expect(ed25519SignatureMatches(params, botToken, publicKeyHex)).toBe(true);
    params.set('signature', 'not-base64url!');
    expect(ed25519SignatureMatches(params, botToken, publicKeyHex)).toBe(false);
    params.set('signature', signature);
    params.set('auth_date', '1');
    expect(ed25519SignatureMatches(params, botToken, publicKeyHex)).toBe(false);
  });

  it('buckets unknown field names so attacker-controlled keys cannot enter logs', () => {
    const params = new URLSearchParams(signedInitData(token, { id: 123 }));
    params.set('PrivateMarker', 'value');
    const diagnostics = miniAppHashDiagnostics(params, params.get('hash') ?? '', token, Date.now());
    expect(diagnostics.fieldNames).toEqual(['auth_date', 'hash', 'unknown', 'user']);
    expect(JSON.stringify(diagnostics)).not.toContain('PrivateMarker');
  });
});
