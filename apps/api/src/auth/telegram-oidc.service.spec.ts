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
  beforeEach(() => {
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
  });
  it.each([
    { iss: 'https://evil.example' },
    { aud: 'another-client' },
    { nonce: 'wrong' },
    { exp: 1 },
    { iat: 1 },
    { iat: 99999999999 },
    { nbf: 99999999999 },
    { id: '123' },
    { aud: ['test-client', 'another'] },
    { azp: 'another' },
  ])('rejects invalid signed claims %j', async (change) => {
    Object.assign(claims, change);
    await expect(callback()).rejects.toThrow('TELEGRAM_AUTH_INVALID');
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
