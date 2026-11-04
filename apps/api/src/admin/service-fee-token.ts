import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { bulkClaims, type BulkClaims } from './service-fee.schema.js';

const developmentKey = randomBytes(32);
function key() {
  const configured = process.env.SERVICE_FEE_PREVIEW_SECRET;
  if (configured && Buffer.byteLength(configured) >= 32) return configured;
  if (process.env.NODE_ENV === 'production')
    throw new ServiceUnavailableException(
      'Массовое управление процентами не настроено.',
    );
  return developmentKey;
}
export const bulkHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function signBulkPreview(claims: BulkClaims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return (
    body + '.' + createHmac('sha256', key()).update(body).digest('base64url')
  );
}
export function readBulkPreview(token: string): BulkClaims {
  const [body, signature, extra] = token.split('.');
  const secret = key();
  try {
    if (!body || !signature || extra !== undefined)
      throw new Error('Token format');
    const expected = createHmac('sha256', secret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
      throw new Error('Signature');
    const parsed: unknown = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    );
    return bulkClaims.parse(parsed);
  } catch {
    throw new ConflictException(
      'Предварительный расчёт недействителен. Обновите предварительный расчёт.',
    );
  }
}
