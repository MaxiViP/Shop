import { randomUUID } from 'node:crypto';
import { bulkApplySchema, bulkPreviewSchema } from './service-fee.schema.js';
import { readBulkPreview, signBulkPreview } from './service-fee-token.js';
import { priceDifferenceBps } from './service-fee.service.js';
import { productQuery } from './schema.js';
import { productWhere } from './product-filter.js';

it('validates server filters and never trusts client prices', () => {
  expect(
    productQuery.parse({ serviceFeeMode: 'review', page: '2', limit: '10' }),
  ).toMatchObject({ serviceFeeMode: 'review', page: 2, limit: 10 });
  expect(productWhere({ serviceFeeMode: 'global' })).toMatchObject({
    serviceMarkupPercentOverride: null,
  });
  expect(productWhere({ serviceFeeMode: 'individual' })).toMatchObject({
    serviceMarkupPercentOverride: { not: null },
  });
  expect(
    productWhere({ serviceFeeMode: 'review', search: 'abc', active: 'true' }),
  ).toMatchObject({ serviceMarkupNeedsReview: true, active: true });
  for (const input of [
    { selection: { kind: 'ids', ids: [] }, mode: 'global' },
    { selection: { kind: 'ids', ids: [1, 1] }, mode: 'global' },
    { selection: { kind: 'filter', filter: { page: 1 } }, mode: 'global' },
    { selection: { kind: 'ids', ids: [1] }, mode: 'global', prices: [1] },
  ])
    expect(bulkPreviewSchema.safeParse(input).success).toBe(false);
  expect(
    bulkApplySchema.safeParse({
      previewToken: 'x',
      requestId: randomUUID(),
      confirmed: false,
    }).success,
  ).toBe(false);
});
it.each([
  [500, 11000, 455],
  [-1000, 11000, -909],
  [0, 10000, 0],
  [1, 200, 50],
  [-1, 200, -50],
])(
  'rounds signed price difference %i/%i to %i bps',
  (difference, before, expected) => {
    expect(priceDifferenceBps(difference, before)).toBe(expected);
  },
);
it('signs versioned actor-bound selection and rejects tampering', () => {
  const claims = {
    version: 1 as const,
    actorId: 1,
    nonce: randomUUID(),
    expiresAt: Date.now() + 1000,
    fingerprint: 'a'.repeat(64),
    mode: 'global' as const,
    selection: { kind: 'ids' as const, ids: [1, 2] },
  };
  const token = signBulkPreview(claims);
  expect(readBulkPreview(token)).toEqual(claims);
  expect(() => readBulkPreview(token + 'x')).toThrow();
  expect(() => readBulkPreview('unsigned')).toThrow();
});
it('does not enable production preview with an ephemeral or short key', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SERVICE_FEE_PREVIEW_SECRET', 'short');
  try {
    expect(() => readBulkPreview('x')).toThrow(
      'Массовое управление процентами не настроено.',
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
