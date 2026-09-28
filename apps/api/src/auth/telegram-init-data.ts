import { UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { z } from 'zod';

export const PROOF_TTL = 300;
export const telegramPhotoUrl = z.string().max(2048).url().refine((value) => {
  const url = URL.parse(value);
  return value === value.trim() && url?.protocol === 'https:' && !url.username && !url.password;
});
export const telegramProfile = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(256).optional(),
  photo_url: telegramPhotoUrl.optional(),
  is_bot: z.literal(false).optional(),
});
export type TelegramProfile = z.infer<typeof telegramProfile>;
export type TelegramProof = {
  profile: TelegramProfile;
  // OIDC-only consented phone metadata; never used for phone authentication.
  phone?: { number: string; verified: boolean };
  tokenHash: string;
  expiresAt: Date;
};

export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function proofHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type MiniAppFailureStage =
  | 'BOT_TOKEN_UNAVAILABLE'
  | 'INIT_DATA_MISSING'
  | 'INIT_DATA_INVALID'
  | 'HASH_INVALID'
  | 'AUTH_DATE_INVALID_OR_EXPIRED'
  | 'PROFILE_INVALID';

const telegramEd25519PublicKey = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const knownMiniAppFields = new Set([
  'auth_date', 'can_send_after', 'chat', 'chat_instance', 'chat_join_request_query_id',
  'chat_type', 'hash', 'query_id', 'receiver', 'signature', 'start_param', 'user',
]);

export type MiniAppHashDiagnostics = {
  fieldNames: string[];
  hasSignature: boolean;
  hmacCurrentMatch: boolean;
  hmacWithoutSignatureMatch: boolean;
  ed25519Valid: boolean;
  authDateBucket: 'fresh' | 'old' | 'future' | 'invalid';
};

function dataCheckString(params: URLSearchParams, withoutSignature: boolean): string {
  const fields = new URLSearchParams(params);
  fields.delete('hash');
  if (withoutSignature) fields.delete('signature');
  fields.sort();
  return [...fields].map(([key, value]) => key + '=' + value).join('\n');
}

function hmacMatches(check: string, hash: string, botToken: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  return sameText(expected, hash);
}

export function ed25519SignatureMatches(
  params: URLSearchParams,
  botToken: string,
  publicKeyHex = telegramEd25519PublicKey,
): boolean {
  const botId = /^([1-9]\d*):/.exec(botToken)?.[1] ?? '';
  const signature = params.get('signature') ?? '';
  if (!botId || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const bytes = Buffer.from(signature, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== signature) return false;
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, Buffer.from(botId + ':WebAppData\n' + dataCheckString(params, true)), key, bytes);
}

function authDateBucket(params: URLSearchParams, now: number): MiniAppHashDiagnostics['authDateBucket'] {
  const date = params.get('auth_date') ?? '';
  if (!/^\d{1,12}$/.test(date)) return 'invalid';
  const seconds = Number(date);
  if (seconds > now / 1000 + 30) return 'future';
  if (seconds + PROOF_TTL <= now / 1000) return 'old';
  return 'fresh';
}

export function miniAppHashDiagnostics(
  params: URLSearchParams,
  hash: string,
  botToken: string,
  now: number,
): MiniAppHashDiagnostics {
  // Unknown names are bucketed so attacker-controlled keys cannot inject values into logs.
  const fieldNames = [...new Set([...params.keys()].map((name) =>
    knownMiniAppFields.has(name) ? name : 'unknown'))].sort();
  let ed25519Valid = false;
  try {
    ed25519Valid = ed25519SignatureMatches(params, botToken);
  } catch {
    // Diagnostics must never change the authentication decision.
  }
  return {
    fieldNames,
    hasSignature: params.has('signature'),
    hmacCurrentMatch: hmacMatches(dataCheckString(params, false), hash, botToken),
    hmacWithoutSignatureMatch: hmacMatches(dataCheckString(params, true), hash, botToken),
    ed25519Valid,
    authDateBucket: authDateBucket(params, now),
  };
}

// Bot-token HMAC validation, not the separate third-party Ed25519 algorithm.
export function verifyInitData(
  raw: string,
  botToken: string,
  now = Date.now(),
  onInvalid?: (stage: MiniAppFailureStage, diagnostics?: MiniAppHashDiagnostics) => void,
): TelegramProof {
  let stage: MiniAppFailureStage = 'INIT_DATA_INVALID';
  try {
    if (!botToken) {
      stage = 'BOT_TOKEN_UNAVAILABLE';
      throw new Error();
    }
    if (!raw) {
      stage = 'INIT_DATA_MISSING';
      throw new Error();
    }
    if (raw.length > 16384) throw new Error();
    const params = new URLSearchParams(raw);
    if (new Set(params.keys()).size !== params.size) throw new Error();
    stage = 'HASH_INVALID';
    const hash = params.get('hash') ?? '';
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error();
    params.delete('hash');
    params.sort();
    const check = [...params]
      .map(([key, value]) => key + '=' + value)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(check).digest('hex');
    if (!sameText(expected, hash)) throw new Error();
    stage = 'AUTH_DATE_INVALID_OR_EXPIRED';
    const date = params.get('auth_date') ?? '';
    if (!/^\d{1,12}$/.test(date)) throw new Error();
    const seconds = Number(date);
    if (seconds > now / 1000 + 30 || seconds + PROOF_TTL <= now / 1000)
      throw new Error();
    stage = 'PROFILE_INVALID';
    const profile = telegramProfile.parse(
      JSON.parse(params.get('user') ?? 'null'),
    );
    return {
      profile,
      // Canonical signed hash remains available for one-time OIDC callers.
      tokenHash: proofHash('mini:' + hash),
      expiresAt: new Date((seconds + PROOF_TTL) * 1000),
    };
  } catch {
    let diagnostics: MiniAppHashDiagnostics | undefined;
    if (stage === 'HASH_INVALID') {
      try {
        const params = new URLSearchParams(raw);
        diagnostics = miniAppHashDiagnostics(params, params.get('hash') ?? '', botToken, now);
      } catch {
        // A diagnostic failure cannot affect the existing rejection path.
      }
    }
    onInvalid?.(stage, diagnostics);
    throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
  }
}
