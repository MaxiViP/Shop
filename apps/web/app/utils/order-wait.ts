export function orderWaitMinutes(updatedAt: string, now: number): number {
  const time = Date.parse(updatedAt);
  return Number.isFinite(time)
    ? Math.max(0, Math.floor((now - time) / 60000))
    : 0;
}
