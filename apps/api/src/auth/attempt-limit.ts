import { HttpException } from '@nestjs/common';

// Single-process, bounded counters. Callers supply canonical framework-resolved IP.
// Multi-instance deployments need a shared limiter (e.g. at the trusted ingress).
export class AttemptLimit {
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(
    private readonly perIp: number,
    private readonly total: number,
    private readonly minutes: number,
  ) {}

  check(ip: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key);
    const buckets = (
      [
        ['global', this.total],
        [`ip:${ip}`, this.perIp],
      ] as const
    ).map(([key, limit]) => {
      const value = this.attempts.get(key) ?? {
        count: 0,
        until: now + this.minutes * 60_000,
      };
      if (value.count >= limit)
        throw new HttpException(
          `Слишком много попыток. Повторите через ${this.minutes} минут`,
          429,
        );
      return { key, value };
    });
    // Check both before charging either: a blocked client must not drain the
    // global budget and lock out every other client by repeating rejected calls.
    for (const { key, value } of buckets) {
      value.count++;
      this.attempts.set(key, value);
    }
  }
}
