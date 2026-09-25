import { UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

// Bot-token HMAC validation, not the separate third-party Ed25519 algorithm.
export function verifyInitData(
  raw: string,
  botToken: string,
  now = Date.now(),
  onInvalid?: (stage: MiniAppFailureStage) => void,
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
    onInvalid?.(stage);
    throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
  }
}
