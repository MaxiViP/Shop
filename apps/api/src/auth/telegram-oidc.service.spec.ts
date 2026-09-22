import { Logger } from '@nestjs/common';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
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
        'OIDC_PROFILE_INVALID',
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
    expect(url.searchParams.get('scope')).toBe('openid profile');
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
    [{ id: '123' }, 'OIDC_PROFILE_INVALID'],
    [{ id: undefined }, 'OIDC_PROFILE_INVALID'],
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
