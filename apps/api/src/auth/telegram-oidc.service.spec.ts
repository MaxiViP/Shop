import { Logger } from '@nestjs/common';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { signedInitData } from '../../test/telegram.fixture.js';
import { verifyInitData } from './telegram-init-data.js';
import { TelegramOidcService } from './telegram-oidc.service.js';

describe('Telegram website OIDC', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'test-key',
    alg: 'RS256',
  };
  const secret = randomBytes(32).toString('hex');
  let service: TelegramOidcService;
  let start: ReturnType<TelegramOidcService['start']>;
  let url: URL;
  let claims: Record<string, unknown>;
  let header: Record<string, unknown>;
  let tokenRequest: RequestInit | undefined;
  const fetchMock = vi.fn();
  let logs: unknown[][];
  const logged = (stage: string) =>
    expect(logs.at(-1)).toEqual(['Telegram OIDC failed: ' + stage]);
  beforeEach(() => {
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (...args: unknown[]) => {
        logs.push(args);
      },
    );
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('TELEGRAM_OIDC_CLIENT_ID', 'test-client');
    vi.stubEnv('TELEGRAM_OIDC_CLIENT_SECRET', secret);
    vi.stubEnv(
      'TELEGRAM_OIDC_REDIRECT_URI',
      'https://shop.example/api/auth/telegram/callback',
    );
    vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    tokenRequest = undefined;
    service = new TelegramOidcService();
    start = service.start();
    url = new URL(start.url);
    const now = Math.floor(Date.now() / 1000);
    claims = {
      iss: 'https://oauth.telegram.org',
      aud: 'test-client',
      sub: 'opaque-not-bot-id',
      id: 123,
      given_name: 'Test',
      preferred_username: 'person',
      iat: now,
      exp: now + 300,
      nonce: url.searchParams.get('nonce'),
    };
    header = { alg: 'RS256', kid: 'test-key' };
    fetchMock.mockImplementation((target: string, init: RequestInit) => {
      if (target.endsWith('/token')) {
        tokenRequest = init;
        const body = [header, claims]
          .map((value) =>
            Buffer.from(JSON.stringify(value)).toString('base64url'),
          )
          .join('.');
        const signature = sign(
          'RSA-SHA256',
          Buffer.from(body),
          pair.privateKey,
        ).toString('base64url');
        return Promise.resolve(
          new Response(JSON.stringify({ id_token: body + '.' + signature })),
        );
      }
      if (target.endsWith('/.well-known/jwks.json'))
        return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] })));
      throw new Error('Unexpected network target');
    });
  });
  afterEach(() => {
    // Exact allowlist: no Error object, provider body, JWT, identity, cookie,
    // state, nonce, client credentials, code or PKCE verifier can appear.
    const allowed = new Set(
      [
        'OIDC_CONFIG_INVALID',
        'OIDC_FLOW_INVALID',
        'OIDC_TOKEN_EXCHANGE_FAILED',
        'OIDC_ID_TOKEN_INVALID',
        'OIDC_JWKS_FAILED',
        'OIDC_JWKS_INVALID',
        'OIDC_SIGNING_KEY_NOT_FOUND',
        'OIDC_SIGNATURE_INVALID',
        'OIDC_CLAIMS_INVALID',
        'OIDC_ISSUER_INVALID',
        'OIDC_AUDIENCE_INVALID',
        'OIDC_TIME_INVALID',
        'OIDC_NONCE_INVALID',
        'OIDC_PROFILE_SUB_INVALID',
        'OIDC_PROFILE_ID_INVALID',
        'OIDC_PROFILE_ID_MISSING',
        'OIDC_PROFILE_ID_NULL',
        'OIDC_PROFILE_ID_NUMBER_NON_INTEGER',
        'OIDC_PROFILE_ID_NUMBER_NON_POSITIVE',
        'OIDC_PROFILE_ID_NUMBER_UNSAFE',
        'OIDC_PROFILE_ID_STRING_NON_POSITIVE',
        'OIDC_PROFILE_ID_STRING_UNSAFE',
        'OIDC_PROFILE_ID_STRING_OTHER',
        'OIDC_PROFILE_ID_OTHER_TYPE',
        'OIDC_PROFILE_NAME_INVALID',
        'OIDC_PROFILE_USERNAME_INVALID',
        'OIDC_PROFILE_GIVEN_NAME_INVALID',
        'OIDC_PROFILE_FAMILY_NAME_INVALID',
        'OIDC_PROFILE_MAPPING_INVALID',
        'OIDC_PROFILE_PICTURE_INVALID',
        'OIDC_PROFILE_PHONE_INVALID',
        'OIDC_PROFILE_PHONE_VERIFIED_INVALID',
      ].map((stage) => 'Telegram OIDC failed: ' + stage),
    );
    for (const call of logs) {
      expect(call).toHaveLength(1);
      expect(allowed.has(String(call[0]))).toBe(true);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const callback = () =>
    service.callback('code', url.searchParams.get('state')!, start.cookie);
  it('uses official code flow, profile, PKCE and server-only exchange', async () => {
    expect(url.origin + url.pathname).toBe('https://oauth.telegram.org/auth');
    expect(url.searchParams.get('scope')).toBe('openid profile phone');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const proof = await callback();
    expect(proof.profile).toEqual({
      id: 123,
      first_name: 'Test',
      username: 'person',
    });
    const verifier = new URLSearchParams(String(tokenRequest!.body)).get(
      'code_verifier',
    )!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(start.url + start.cookie + JSON.stringify(proof)).not.toContain(
      secret,
    );
    expect(service.destination()).toBe('https://shop.example/profile');
    expect(logs).toEqual([]);
  });
  it('carries only a valid order return path in the encrypted flow and preserves normal login', async () => {
    const target = '/order/12345678-1234-4234-8234-123456789abc';
    start = service.start(target);
    url = new URL(start.url);
    claims.nonce = url.searchParams.get('nonce');
    const proof = await callback();
    expect(proof.returnTo).toBe(target);
    expect(service.destination(false, proof.returnTo)).toBe('https://shop.example' + target);
    expect(service.destination()).toBe('https://shop.example/profile');
    expect(start.url).not.toContain(target);
    expect(logs).toEqual([]);
  });
  it('accepts an uppercase UUID spelling without changing the exact destination', async () => {
    const target = '/order/ABCDEF12-1234-4234-8234-ABCDEF123456';
    start = service.start(target);
    url = new URL(start.url);
    claims.nonce = url.searchParams.get('nonce');
    expect((await callback()).returnTo).toBe(target);
    expect(service.destination(false, target)).toBe('https://shop.example' + target);
  });
  it.each([
    'https://evil.example/order/12345678-1234-4234-8234-123456789abc',
    '//evil.example', 'javascript:alert(1)',
    '/\\\\evil.example/order/12345678-1234-4234-8234-123456789abc',
    '/order/%2f%2fevil.example',
    '/order/12345678-1234-4234-8234-123456789abc?next=//evil.example',
    '/order/not-a-uuid',
  ])('rejects untrusted returnTo %s and keeps the profile destination', async target => {
    start = service.start(target);
    url = new URL(start.url);
    claims.nonce = url.searchParams.get('nonce');
    expect((await callback()).returnTo).toBeUndefined();
    expect(service.destination(false, target)).toBe('https://shop.example/profile');
  });
  it('maps consented OIDC avatar and verified phone as separate metadata', async () => {
    claims.picture = 'https://cdn4.telesco.pe/avatar.webp';
    claims.phone_number = '79991234567';
    claims.phone_number_verified = true;
    const proof = await callback();
    expect(proof.profile.photo_url).toBe(claims.picture);
    expect(proof.phone).toEqual({ number: '+79991234567', verified: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // token + JWKS, never avatar
    expect(logs).toEqual([]);
  });
  it.each([{}, { picture: null, phone_number: null, phone_number_verified: null }])(
    'does not require optional photo or phone metadata %#', async (metadata) => {
      Object.assign(claims, metadata);
      const proof = await callback();
      expect(proof.profile.photo_url).toBeUndefined();
      expect(proof.phone).toBeUndefined();
      expect(logs).toEqual([]);
    },
  );
  it('only marks the supplied phone verified on explicit boolean true', async () => {
    claims.phone_number = '+79991234567';
    expect((await callback()).phone).toEqual({ number: '+79991234567', verified: false });
    delete claims.phone_number;
    claims.phone_number_verified = true;
    expect((await callback()).phone).toBeUndefined();
  });
  it.each([
    [{ picture: 'http://example.test/photo' }, 'OIDC_PROFILE_PICTURE_INVALID'],
    [{ picture: 'javascript:alert(1)' }, 'OIDC_PROFILE_PICTURE_INVALID'],
    [{ picture: 'https://user:password@example.test/photo' }, 'OIDC_PROFILE_PICTURE_INVALID'],
    [{ picture: 'https://example.test/' + 'x'.repeat(2048) }, 'OIDC_PROFILE_PICTURE_INVALID'],
    [{ picture: 123 }, 'OIDC_PROFILE_PICTURE_INVALID'],
    [{ phone_number: 79991234567 }, 'OIDC_PROFILE_PHONE_INVALID'],
    [{ phone_number: 'not-a-phone' }, 'OIDC_PROFILE_PHONE_INVALID'],
    [{ phone_number: '+79991234567\n' }, 'OIDC_PROFILE_PHONE_INVALID'],
    [{ phone_number: '+1234567890123456' }, 'OIDC_PROFILE_PHONE_INVALID'],
    [{ phone_number_verified: 'true' }, 'OIDC_PROFILE_PHONE_VERIFIED_INVALID'],
  ])('rejects invalid signed metadata variant %# without logging values', async (metadata, stage) => {
    Object.assign(claims, metadata);
    await expect(callback()).rejects.toThrow(/^TELEGRAM_AUTH_INVALID$/);
    expect(logs).toEqual([['Telegram OIDC failed: ' + stage]]);
  });
  it.each([987654321, 2 ** 32, Number.MAX_SAFE_INTEGER])(
    'keeps the same verified numeric identity across OIDC and Mini App variant %#',
    async (id) => {
      // Official OIDC example: sub is a separate string, not the Bot user ID.
      claims.sub = '1234123412341234123';
      claims.id = id;
      const oidc = await callback();
      const botToken = randomBytes(32).toString('hex');
      const miniApp = verifyInitData(signedInitData(botToken, { id }), botToken);
      expect(oidc.profile.id).toBe(id);
      expect(oidc.profile.id).toBe(miniApp.profile.id);
      // Both channels reach TelegramAuthService.login with this same DB lookup key.
      expect(BigInt(oidc.profile.id)).toBe(BigInt(miniApp.profile.id));
      expect(logs).toEqual([]);
    },
  );
  it.each([
    ['123456789', 123456789],
    ['123', 123],
    ['987654321', 987654321],
    ['000123456789', 123456789],
    ['1', 1],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)(
    'normalizes a signed decimal OIDC ID to the same Mini App identity key variant %#',
    async (rawId, id) => {
      claims.id = rawId;
      const oidc = await callback();
      const botToken = randomBytes(32).toString('hex');
      const miniApp = verifyInitData(signedInitData(botToken, { id }), botToken);
      expect(oidc.profile.id).toBe(id);
      expect(oidc.profile.id).toBe(miniApp.profile.id);
      expect(BigInt(oidc.profile.id)).toBe(BigInt(miniApp.profile.id));
      expect(logs).toEqual([]);
    },
  );
  it.each([
    [undefined, 'OIDC_PROFILE_ID_MISSING'],
    [null, 'OIDC_PROFILE_ID_NULL'],
    [0, 'OIDC_PROFILE_ID_NUMBER_NON_POSITIVE'],
    [-1, 'OIDC_PROFILE_ID_NUMBER_NON_POSITIVE'],
    [1.5, 'OIDC_PROFILE_ID_NUMBER_NON_INTEGER'],
    [Number.MAX_SAFE_INTEGER + 1, 'OIDC_PROFILE_ID_NUMBER_UNSAFE'],
    [{}, 'OIDC_PROFILE_ID_OTHER_TYPE'],
    [[], 'OIDC_PROFILE_ID_OTHER_TYPE'],
  ] as const)(
    'never substitutes a numeric-looking sub for an invalid id variant %#',
    async (id, stage) => {
      claims.sub = '987654321';
      claims.id = id;
      await expect(callback()).rejects.toThrow(/^TELEGRAM_AUTH_INVALID$/);
      logged(stage);
      expect(logs).toHaveLength(1);
    },
  );
  it.each([
    {
      profile: {
        id: 123,
        name: 'Maksim',
        preferred_username: null,
        given_name: null,
        family_name: null,
      },
      expected: { id: 123, first_name: 'Maksim' },
    },
    {
      profile: { id: 123, name: 'Maksim' },
      expected: { id: 123, first_name: 'Maksim' },
    },
    {
      profile: { id: 123, preferred_username: 'max' },
      expected: { id: 123, username: 'max' },
    },
    {
      profile: {
        id: 123,
        name: null,
        given_name: null,
        family_name: null,
        preferred_username: null,
      },
      expected: { id: 123 },
    },
    {
      profile: {
        id: 123,
        name: 'Maksim Petrov',
        given_name: 'Maksim',
        family_name: 'Petrov',
      },
      expected: { id: 123, first_name: 'Maksim Petrov' },
    },
    {
      profile: {
        id: 123,
        name: 'Maksim Ivanov',
        given_name: null,
        family_name: 'Ivanov',
      },
      expected: { id: 123, first_name: 'Maksim Ivanov' },
    },
    {
      profile: { id: 123, name: null, given_name: 'Maksim', family_name: 'Petrov' },
      expected: { id: 123, first_name: 'Maksim', last_name: 'Petrov' },
    },
    {
      profile: { id: 123, name: 'x'.repeat(512) },
      expected: { id: 123, first_name: 'x'.repeat(512) },
    },
    {
      profile: {
        id: 123,
        given_name: 'x'.repeat(256),
        family_name: 'y'.repeat(256),
        preferred_username: 'z'.repeat(256),
      },
      expected: {
        id: 123,
        first_name: 'x'.repeat(256),
        last_name: 'y'.repeat(256),
        username: 'z'.repeat(256),
      },
    },
  ])('accepts optional OIDC profile variant %#', async ({ profile, expected }) => {
    for (const field of ['given_name', 'family_name', 'name', 'preferred_username'])
      delete claims[field];
    Object.assign(claims, profile);
    const proof = await callback();
    expect(proof.profile).toEqual(expected);
    expect(Object.values(proof.profile)).not.toContain(null);
    expect(logs).toEqual([]);
  });
  it.each([
    [null, 'OIDC_PROFILE_ID_NULL'],
    [-1, 'OIDC_PROFILE_ID_NUMBER_NON_POSITIVE'],
    [0, 'OIDC_PROFILE_ID_NUMBER_NON_POSITIVE'],
    [1.5, 'OIDC_PROFILE_ID_NUMBER_NON_INTEGER'],
    [Number.MAX_SAFE_INTEGER + 1, 'OIDC_PROFILE_ID_NUMBER_UNSAFE'],
  ] as const)(
    'rejects invalid numeric identity variant %# at the profile stage',
    async (id, stage) => {
      claims.id = id;
      await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
      logged(stage);
    },
  );
  it.each([
    ['', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['abc', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['123abc', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['-1', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['+1', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['1.2', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['1e3', 'OIDC_PROFILE_ID_STRING_OTHER'],
    [' ', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['123 ', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['123\n', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['123\r\n', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['\t123', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['000', 'OIDC_PROFILE_ID_STRING_NON_POSITIVE'],
    ['999999999999999999999999999999', 'OIDC_PROFILE_ID_STRING_UNSAFE'],
    ['private-id-not-for-logs', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['-123', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['1.5', 'OIDC_PROFILE_ID_STRING_OTHER'],
    [' 123', 'OIDC_PROFILE_ID_STRING_OTHER'],
    ['0', 'OIDC_PROFILE_ID_STRING_NON_POSITIVE'],
    ['9007199254740992', 'OIDC_PROFILE_ID_STRING_UNSAFE'],
    [false, 'OIDC_PROFILE_ID_OTHER_TYPE'],
    [{ private: 'must-not-appear-in-logs' }, 'OIDC_PROFILE_ID_OTHER_TYPE'],
  ] as const)('rejects invalid ID variant %# without logging values', async (id, stage) => {
    claims.id = id;
    await expect(callback()).rejects.toThrow(/^TELEGRAM_AUTH_INVALID$/);
    expect(logs).toEqual([['Telegram OIDC failed: ' + stage]]);
  });
  it.each([
    ['given_name', 'x'.repeat(257), 'OIDC_PROFILE_GIVEN_NAME_INVALID'],
    ['family_name', 'x'.repeat(257), 'OIDC_PROFILE_FAMILY_NAME_INVALID'],
    ['preferred_username', 'x'.repeat(257), 'OIDC_PROFILE_USERNAME_INVALID'],
    ['name', 'x'.repeat(513), 'OIDC_PROFILE_NAME_INVALID'],
    ['given_name', 123, 'OIDC_PROFILE_GIVEN_NAME_INVALID'],
    ['family_name', {}, 'OIDC_PROFILE_FAMILY_NAME_INVALID'],
    ['preferred_username', [], 'OIDC_PROFILE_USERNAME_INVALID'],
    ['name', true, 'OIDC_PROFILE_NAME_INVALID'],
  ] as const)('diagnoses invalid profile field %s safely', async (field, value, stage) => {
    claims[field] = value;
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    logged(stage);
  });
  it.each([undefined, null, '', 123, {}])(
    'diagnoses missing or invalid sub variant %# without using it as identity',
    async (sub) => {
      claims.sub = sub;
      await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
      logged('OIDC_PROFILE_SUB_INVALID');
    },
  );
  it('diagnoses internal mapping failure without logging the error or profile', async () => {
    // All signed fields are valid; inject only a failure at the mapping boundary.
    vi.resetModules();
    vi.doMock('./telegram-init-data.js', async () => {
      const actual = await vi.importActual<typeof import('./telegram-init-data.js')>(
        './telegram-init-data.js',
      );
      return {
        ...actual,
        telegramProfile: {
          extend: () => ({
            parse: () => {
              throw new Error(JSON.stringify(claims) + secret);
            },
          }),
        },
      };
    });
    try {
      const { TelegramOidcService: MappingFailureService } = await import(
        './telegram-oidc.service.js'
      );
      service = new MappingFailureService();
      await expect(callback()).rejects.toThrow(/^TELEGRAM_AUTH_INVALID$/);
      logged('OIDC_PROFILE_MAPPING_INVALID');
      expect(logs).toHaveLength(1);
    } finally {
      vi.doUnmock('./telegram-init-data.js');
      vi.resetModules();
    }
  });
  it('rejects wrong/missing state, tampered cookie and expired flow before network', async () => {
    for (const [state, cookie] of [
      ['wrong', start.cookie],
      ['', start.cookie],
      [url.searchParams.get('state')!, 'broken'],
    ])
      await expect(service.callback('code', state!, cookie!)).rejects.toThrow(
        'TELEGRAM_AUTH_INVALID',
      );
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    time.mockRestore();
    expect(fetchMock).not.toHaveBeenCalled();
    logged('OIDC_FLOW_INVALID');
  });
  it.each([
    [{ iss: 'https://evil.example' }, 'OIDC_ISSUER_INVALID'],
    [{ aud: 'another-client' }, 'OIDC_AUDIENCE_INVALID'],
    [{ nonce: 'wrong' }, 'OIDC_NONCE_INVALID'],
    [{ nonce: undefined }, 'OIDC_NONCE_INVALID'],
    [{ exp: 1 }, 'OIDC_TIME_INVALID'],
    [{ iat: 1 }, 'OIDC_TIME_INVALID'],
    [{ iat: 99999999999 }, 'OIDC_TIME_INVALID'],
    [{ nbf: 99999999999 }, 'OIDC_TIME_INVALID'],
    [{ id: '123abc' }, 'OIDC_PROFILE_ID_STRING_OTHER'],
    [{ id: undefined }, 'OIDC_PROFILE_ID_MISSING'],
    [{ aud: ['test-client', 'another'] }, 'OIDC_AUDIENCE_INVALID'],
    [{ azp: 'another' }, 'OIDC_AUDIENCE_INVALID'],
  ])('diagnoses signed claim failure %j as %s', async (change, stage) => {
    Object.assign(claims, change);
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    logged(stage as string);
  });
  it('rejects algorithm confusion and signature substitution', async () => {
    header.alg = 'HS256';
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    header.alg = 'RS256';
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id_token:
              [header, claims]
                .map((value) =>
                  Buffer.from(JSON.stringify(value)).toString('base64url'),
                )
                .join('.') + '.AAAA',
          }),
        ),
      ),
    );
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
  });
  it('logs token endpoint 400 without reading/logging its sensitive body', async () => {
    const response = new Response(secret + ' provider body private-user', {
      status: 400,
    });
    const read = vi.spyOn(response, 'text');
    fetchMock.mockResolvedValue(response);
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    logged('OIDC_TOKEN_EXCHANGE_FAILED');
    expect(logs).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['not-a-jwt', 'a.b.c', '', undefined])(
    'diagnoses malformed id_token without logging it',
    async (token) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ id_token: token })),
      );
      await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
      logged('OIDC_ID_TOKEN_INVALID');
    },
  );
  it.each(['network', 'http', 'shape', 'json', 'key'])(
    'diagnoses JWKS %s independently',
    async (failure) => {
      const normal = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((target: string, init: RequestInit) => {
        if (!target.endsWith('/.well-known/jwks.json'))
          return normal(target, init);
        if (failure === 'network')
          return Promise.reject(new Error(secret + ' provider body'));
        if (failure === 'http')
          return Promise.resolve(new Response(secret, { status: 500 }));
        if (failure === 'json') return Promise.resolve(new Response(secret));
        return Promise.resolve(
          new Response(
            JSON.stringify(
              failure === 'shape'
                ? { keys: 'private-provider-body' }
                : { keys: [{ ...jwk, kid: 'different-sensitive-kid' }] },
            ),
          ),
        );
      });
      await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
      logged(
        failure === 'network' || failure === 'http'
          ? 'OIDC_JWKS_FAILED'
          : failure === 'key'
            ? 'OIDC_SIGNING_KEY_NOT_FOUND'
            : 'OIDC_JWKS_INVALID',
      );
    },
  );
  it('diagnoses an invalid signature independently', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id_token:
              [header, claims]
                .map((value) =>
                  Buffer.from(JSON.stringify(value)).toString('base64url'),
                )
                .join('.') + '.AAAA',
          }),
        ),
      ),
    );
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    logged('OIDC_SIGNATURE_INVALID');
  });
  it('diagnoses a correctly signed malformed claims payload', async () => {
    const body =
      Buffer.from(JSON.stringify(header)).toString('base64url') +
      '.' +
      Buffer.from('{private-data').toString('base64url');
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id_token:
              body +
              '.' +
              sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString(
                'base64url',
              ),
          }),
        ),
      ),
    );
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
    logged('OIDC_CLAIMS_INVALID');
  });
  it('uses the exact configured production callback in both authorization and exchange', async () => {
    const redirect = 'https://korzinamarket.ru/api/auth/telegram/callback';
    vi.stubEnv('TELEGRAM_OIDC_REDIRECT_URI', redirect);
    start = service.start();
    url = new URL(start.url);
    claims.nonce = url.searchParams.get('nonce');
    await callback();
    expect(url.searchParams.get('redirect_uri')).toBe(redirect);
    expect(
      new URLSearchParams(String(tokenRequest!.body)).get('redirect_uri'),
    ).toBe(redirect);
    for (const invalid of [
      redirect + '/',
      'https://korzinamarket.ru/api/auth/telegram',
    ]) {
      vi.stubEnv('TELEGRAM_OIDC_REDIRECT_URI', invalid);
      expect(service.available).toBe(false);
    }
  });
  it('never returns provider error bodies/secrets', async () => {
    fetchMock.mockRejectedValue(new Error(secret));
    await expect(callback()).rejects.toThrow(/^TELEGRAM_AUTH_INVALID$/);
    fetchMock.mockResolvedValue(new Response(secret, { status: 500 }));
    await expect(callback()).rejects.toThrow(/^TELEGRAM_AUTH_INVALID$/);
  });
  it('is unavailable without credentials / exact secure redirect; never invents defaults', () => {
    vi.stubEnv('TELEGRAM_OIDC_CLIENT_SECRET', '');
    expect(service.available).toBe(false);
    expect(() => service.start()).toThrow('TELEGRAM_LOGIN_UNAVAILABLE');
    vi.stubEnv('TELEGRAM_OIDC_CLIENT_SECRET', secret);
    vi.stubEnv('TELEGRAM_OIDC_REDIRECT_URI', 'https://shop.example/other');
    expect(service.available).toBe(false);
    vi.stubEnv(
      'TELEGRAM_OIDC_REDIRECT_URI',
      'http://evil.example/api/auth/telegram/callback',
    );
    expect(service.available).toBe(false);
  });
});
