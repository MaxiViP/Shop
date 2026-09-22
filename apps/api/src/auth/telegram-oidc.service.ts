import {
  Injectable,
  Logger,
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
  given_name: z.string().max(256).nullish(),
  family_name: z.string().max(256).nullish(),
  name: z.string().max(512).nullish(),
  preferred_username: z.string().max(256).nullish(),
});
// OIDC name is a full display name, unlike the Mini App first_name field.
const oidcProfile = telegramProfile.extend({
  first_name: z.string().max(512).optional(),
});
type Flow = z.infer<typeof flowSchema>;
type Key = z.infer<typeof jwkSchema>;

@Injectable()
export class TelegramOidcService {
  private readonly logger = new Logger(TelegramOidcService.name);
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
    let stage = 'OIDC_CONFIG_INVALID';
    try {
      const config = this.requiredConfig();
      stage = 'OIDC_FLOW_INVALID';
      const flow = this.readFlow(cookie, state, config.secret);
      if (!code || code.length > 4096) throw new Error();
      stage = 'OIDC_TOKEN_EXCHANGE_FAILED';
      const response = await this.request(issuer + '/token', {
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
      stage = 'OIDC_ID_TOKEN_INVALID';
      const data = await this.json(response);
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
        stage = 'OIDC_JWKS_FAILED';
        const response = await this.request(issuer + '/.well-known/jwks.json');
        stage = 'OIDC_JWKS_INVALID';
        const raw = await this.json(response);
        const entries = z
          .object({ keys: z.array(z.unknown()).max(32) })
          .parse(raw).keys;
        this.keys = entries.flatMap((value) => {
          const parsed = jwkSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        this.keysUntil = Date.now() + 60_000;
      }
      stage = 'OIDC_SIGNING_KEY_NOT_FOUND';
      const jwk = this.keys.find((key) => key.kid === header.kid);
      if (!jwk) throw new Error();
      stage = 'OIDC_JWKS_INVALID';
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      stage = 'OIDC_SIGNATURE_INVALID';
      if (
        !verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          publicKey,
          Buffer.from(parts[2]!, 'base64url'),
        )
      )
        throw new Error();
      stage = 'OIDC_CLAIMS_INVALID';
      const rawClaims = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
        );
      stage = 'OIDC_ISSUER_INVALID';
      claimsSchema.pick({ iss: true }).parse(rawClaims);
      stage = 'OIDC_AUDIENCE_INVALID';
      const recipient = claimsSchema
        .pick({ aud: true, azp: true })
        .parse(rawClaims);
      const audience = Array.isArray(recipient.aud)
        ? recipient.aud
        : [recipient.aud];
      if (
        !audience.includes(config.clientId) ||
        (audience.length > 1 && recipient.azp !== config.clientId) ||
        (recipient.azp && recipient.azp !== config.clientId)
      )
        throw new Error();
      stage = 'OIDC_TIME_INVALID';
      const time = claimsSchema
        .pick({ exp: true, iat: true, nbf: true })
        .parse(rawClaims);
      const now = Date.now() / 1000;
      if (
        time.exp <= now ||
        time.iat > now + 30 ||
        time.iat + PROOF_TTL <= now ||
        (time.nbf !== undefined && time.nbf > now + 30)
      )
        throw new Error();
      stage = 'OIDC_NONCE_INVALID';
      const { nonce } = claimsSchema.pick({ nonce: true }).parse(rawClaims);
      if (!sameText(nonce, flow.nonce)) throw new Error();
      stage = 'OIDC_PROFILE_SUB_INVALID';
      claimsSchema.shape.sub.parse(rawClaims.sub);
      stage = 'OIDC_PROFILE_ID_INVALID';
      const id = claimsSchema.shape.id.parse(rawClaims.id);
      stage = 'OIDC_PROFILE_NAME_INVALID';
      const name = claimsSchema.shape.name.parse(rawClaims.name);
      stage = 'OIDC_PROFILE_USERNAME_INVALID';
      const username = claimsSchema.shape.preferred_username.parse(
        rawClaims.preferred_username,
      );
      stage = 'OIDC_PROFILE_GIVEN_NAME_INVALID';
      const givenName = claimsSchema.shape.given_name.parse(rawClaims.given_name);
      stage = 'OIDC_PROFILE_FAMILY_NAME_INVALID';
      const familyName = claimsSchema.shape.family_name.parse(rawClaims.family_name);
      stage = 'OIDC_PROFILE_MAPPING_INVALID';
      // Telegram's verified numeric "id" is the Bot/Mini App identity; sub is opaque.
      const profile = oidcProfile.parse({
        id,
        first_name: name ?? givenName ?? undefined,
        // The full display name already includes any family name.
        last_name: name != null ? undefined : familyName ?? undefined,
        username: username ?? undefined,
      });
      return {
        profile,
        tokenHash: proofHash('oidc:' + flow.state),
        expiresAt: new Date(
          Math.min(
            flow.expiresAt,
            time.exp * 1000,
            (time.iat + PROOF_TTL) * 1000,
          ),
        ),
      };
    } catch {
      // Only locally assigned static codes; never log a caught error or payload.
      this.logger.warn('Telegram OIDC failed: ' + stage);
      if (stage === 'OIDC_CONFIG_INVALID')
        throw new ServiceUnavailableException('TELEGRAM_LOGIN_UNAVAILABLE');
      throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
    }
  }

  destination(failed = false) {
    return (
      this.requiredConfig().site +
      (failed ? '/telegram?error=login' : '/profile')
    );
  }

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error();
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length > 65536) throw new Error();
    return JSON.parse(text) as unknown;
  }
}
