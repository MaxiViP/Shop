import { actionableQueue, assemblyMinutes, peakActive, waitRange } from './queue.js';

const now = new Date('2026-10-02T10:00:00.000Z');
const row = (id: number, minute: number, scheduledFor: Date | null = null) => ({
  id, createdAt: new Date(now.getTime() + minute * 60_000),
  fulfillmentMode: scheduledFor ? 'SCHEDULED' as const : 'ASAP' as const, scheduledFor,
});

describe('queue estimation and fairness', () => {
  it('uses rolling median only after five valid samples', () => {
    expect(assemblyMinutes([5, 10, 12, 18], 25)).toBe(25);
    expect(assemblyMinutes([5, 10, 12, 18, 100, 999], 25)).toBe(12);
  });
  it('keeps ASAP FIFO, excludes future scheduled and prioritizes only due scheduled', () => {
    const due = new Date(now.getTime() + 20 * 60_000);
    const future = new Date(now.getTime() + 90 * 60_000);
    const queue = actionableQueue([row(2, -2), row(4, -10, future), row(1, -5), row(3, -4, due)], now, 25);
    expect(queue.map(item => item.id)).toEqual([3, 1, 2]);
  });
  it('includes active residual without assigning active order a waiting position', () => {
    expect(waitRange(2, [{ assemblyStartedAt: new Date(now.getTime() - 10 * 60_000) }], now, 25))
      .toEqual({ min: 30, max: 60 });
  });
  it('estimates parallel assembly lanes while keeping ordinal queue positions', () => {
    expect(waitRange(4, [], now, 25, 1)).toEqual({ min: 55, max: 110 });
    expect(waitRange(4, [], now, 25, 2)).toEqual({ min: 15, max: 40 });
    expect(waitRange(1, [{ assemblyStartedAt: now }], now, 25, 2))
      .toEqual({ min: 0, max: 10 });
  });
  it('treats scheduledFor as ready-by time and starts preparation one estimate earlier', () => {
    const ready = new Date(now.getTime() + 25 * 60_000);
    const scheduled = row(3, -3, ready);
    expect(actionableQueue([scheduled], new Date(now.getTime() - 1), 25)).toEqual([]);
    expect(actionableQueue([scheduled], now, 25).map(item => item.id)).toEqual([3]);
  });
  it('peak window ends without an administrator toggle', () => {
    const settings = { peakModeEnabled: true,
      peakModeStart: new Date(now.getTime() - 60_000),
      peakModeEnd: new Date(now.getTime() + 60_000) };
    expect(peakActive(settings, now)).toBe(true);
    expect(peakActive(settings, settings.peakModeEnd)).toBe(false);
  });
});
