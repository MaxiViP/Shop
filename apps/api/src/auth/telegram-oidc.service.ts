import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { z } from 'zod';
import {
  PROOF_TTL,
  proofHash,
  sameText,
  telegramProfile,
  type TelegramProof,
} from './telegram-init-data.js';

const issuer = 'https://oauth.telegram.org';
const flowSchema = z.object({
  state: z.string().length(43),
  nonce: z.string().length(43),
  verifier: z.string().length(43),
  expiresAt: z.number().int(),
});
const jwkSchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1),
  n: z.string(),
  e: z.string(),
  alg: z.literal('RS256').optional(),
  use: z.literal('sig').optional(),
});
const claimsSchema = z.object({
  iss: z.literal(issuer),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  azp: z.string().optional(),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  nonce: z.string(),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  given_name: z.string().max(256).optional(),
  family_name: z.string().max(256).optional(),
  name: z.string().max(512).optional(),
  preferred_username: z.string().max(256).optional(),
});
type Flow = z.infer<typeof flowSchema>;
type Key = z.infer<typeof jwkSchema>;

@Injectable()
export class TelegramOidcService {
  private keys: Key[] = [];
  private keysUntil = 0;

  private config() {
    const clientId = process.env.TELEGRAM_OIDC_CLIENT_ID;
    const clientSecret = process.env.TELEGRAM_OIDC_CLIENT_SECRET;
    const redirectUri = process.env.TELEGRAM_OIDC_REDIRECT_URI;
    const site = process.env.ORDER_SITE_URL;
    const secret = process.env.AUTH_SECRET;
    if (!clientId || !clientSecret || !redirectUri || !site || !secret)
      return null;
    try {
      for (const value of [redirectUri, site]) {
        const url = new URL(value);
        const local =
          process.env.NODE_ENV !== 'production' &&
          ['localhost', '127.0.0.1'].includes(url.hostname);
        if (
          (!local && url.protocol !== 'https:') ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          return null;
      }
      const redirect = new URL(redirectUri);
      if (redirect.pathname !== '/api/auth/telegram/callback') return null;
      if (new URL(site).pathname !== '/') return null;
      return {
        clientId,
        clientSecret,
        redirectUri,
        site: new URL(site).origin,
        secret,
      };
    } catch {
      return null;
    }
  }

  get available() {
    return this.config() !== null;
  }

  private requiredConfig() {
    const config = this.config();
    if (!config)
      throw new ServiceUnavailableException('TELEGRAM_LOGIN_UNAVAILABLE');
    return config;
  }

  start() {
    const config = this.requiredConfig();
    const flow: Flow = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + PROOF_TTL * 1000,
    };
    const url = new URL(issuer + '/auth');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash('sha256')
        .update(flow.verifier)
        .digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.cookieKey(config.secret),
      iv,
    );
    cipher.setAAD(Buffer.from('telegram-oidc'));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(flow), 'utf8'),
      cipher.final(),
    ]);
    return {
      url: url.href,
      cookie: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        'base64url',
      ),
    };
  }

  private cookieKey(secret: string) {
    return createHash('sha256')
      .update('telegram-oidc:' + secret)
      .digest();
  }

  private readFlow(cookie: string, state: string, secret: string): Flow {
    if (!cookie || cookie.length > 2048 || !state || state.length > 128)
      throw new Error();
    const bytes = Buffer.from(cookie, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.cookieKey(secret),
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from('telegram-oidc'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
    const flow = flowSchema.parse(JSON.parse(data.toString('utf8')));
    if (flow.expiresAt <= Date.now() || !sameText(flow.state, state))
      throw new Error();
    return flow;
  }

  async callback(
    code: string,
    state: string,
    cookie: string,
  ): Promise<TelegramProof> {
    const config = this.requiredConfig();
    try {
      const flow = this.readFlow(cookie, state, config.secret);
      if (!code || code.length > 4096) throw new Error();
      const data = await this.json(issuer + '/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(config.clientId + ':' + config.clientSecret).toString(
              'base64',
            ),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          code_verifier: flow.verifier,
        }).toString(),
      });
      const { id_token: token } = z
        .object({ id_token: z.string().min(1).max(16384) })
        .parse(data);
      const parts = token.split('.');
      if (
        parts.length !== 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
      )
        throw new Error();
      const header = z
        .object({
          alg: z.literal('RS256'),
          kid: z.string().min(1).max(256),
          crit: z.never().optional(),
        })
        .parse(
          JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')),
        );
      if (this.keysUntil <= Date.now()) {
        const raw = await this.json(issuer + '/.well-known/jwks.json');
        const entries = z
          .object({ keys: z.array(z.unknown()).max(32) })
          .parse(raw).keys;
        this.keys = entries.flatMap((value) => {
          const parsed = jwkSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        this.keysUntil = Date.now() + 60_000;
      }
      const jwk = this.keys.find((key) => key.kid === header.kid);
      if (
        !jwk ||
        !verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          createPublicKey({ key: jwk, format: 'jwk' }),
          Buffer.from(parts[2]!, 'base64url'),
        )
      )
        throw new Error();
      const claims = claimsSchema.parse(
        JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
      );
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const now = Date.now() / 1000;
      if (
        !audience.includes(config.clientId) ||
        (audience.length > 1 && claims.azp !== config.clientId) ||
        (claims.azp && claims.azp !== config.clientId) ||
        claims.exp <= now ||
        claims.iat > now + 30 ||
        claims.iat + PROOF_TTL <= now ||
        (claims.nbf !== undefined && claims.nbf > now + 30) ||
        !sameText(claims.nonce, flow.nonce)
      )
        throw new Error();
      // Telegram's verified numeric "id" is the Bot/Mini App identity; sub is opaque.
      const profile = telegramProfile.parse({
        id: claims.id,
        first_name: claims.given_name ?? claims.name,
        last_name: claims.family_name,
        username: claims.preferred_username,
      });
      return {
        profile,
        tokenHash: proofHash('oidc:' + flow.state),
        expiresAt: new Date(
          Math.min(
            flow.expiresAt,
            claims.exp * 1000,
            (claims.iat + PROOF_TTL) * 1000,
          ),
        ),
      };
    } catch {
      // Never surface provider body, authorization header, code, token or crypto errors.
      throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
    }
  }

  destination(failed = false) {
    return (
      this.requiredConfig().site +
      (failed ? '/telegram?error=login' : '/profile')
    );
  }

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (text.length > 65536) throw new Error();
    return JSON.parse(text) as unknown;
  }
}
