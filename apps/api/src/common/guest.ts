import { createHash, randomBytes } from 'node:crypto';

export const GUEST_TTL = 30 * 24 * 60 * 60 * 1000;

export const GID = process.env.NODE_ENV === 'production' ? '__Host-gid' : 'gid';

export function createGuestToken() {
  return randomBytes(32).toString('hex');
}

export function guestTokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
