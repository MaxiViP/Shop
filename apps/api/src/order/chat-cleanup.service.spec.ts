import { expect, it } from 'vitest';
import { imageExpiry } from './chat-cleanup.service.js';

const start = new Date('2026-10-01T00:00:00.000Z');
const next = new Date('2026-10-02T00:00:00.000Z');
const base = {
  createdAt: start,
  orderStatus: 'NEW' as const,
  completedAt: null,
  canceledAt: null,
  orderUpdatedAt: next,
};

it('never expires an operational photo while the order is active', () => {
  expect(imageExpiry({ ...base, retention: 'OPERATIONAL' })).toBeNull();
});

it('expires completed or canceled operational photos after seven days', () => {
  expect(imageExpiry({ ...base, retention: 'OPERATIONAL',
    orderStatus: 'COMPLETED', completedAt: next })?.toISOString())
    .toBe('2026-10-09T00:00:00.000Z');
  expect(imageExpiry({ ...base, retention: 'OPERATIONAL',
    orderStatus: 'CANCELED', canceledAt: next })?.toISOString())
    .toBe('2026-10-09T00:00:00.000Z');
  expect(imageExpiry({ ...base, retention: 'OPERATIONAL',
    orderStatus: 'NEW', canceledAt: next })).toBeNull();
  expect(imageExpiry({ ...base, retention: 'OPERATIONAL',
    createdAt: new Date('2026-10-03T00:00:00.000Z'),
    orderStatus: 'COMPLETED', completedAt: next })?.toISOString())
    .toBe('2026-10-10T00:00:00.000Z');
});

it('keeps evidence for 90 days from the last relevant event or issue closure', () => {
  expect(imageExpiry({ ...base, retention: 'EVIDENCE' })).toBeNull();
  expect(imageExpiry({ ...base, retention: 'EVIDENCE',
    orderStatus: 'COMPLETED', completedAt: next })?.toISOString())
    .toBe('2026-12-31T00:00:00.000Z');
  const issue = { status: 'WAITING_CUSTOMER', updatedAt: next, resolvedAt: null };
  expect(imageExpiry({ ...base, retention: 'EVIDENCE', issue })).toBeNull();
  expect(imageExpiry({ ...base, retention: 'EVIDENCE', issue: {
    ...issue, status: 'RESOLVED', resolvedAt: next,
  } })?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
});
