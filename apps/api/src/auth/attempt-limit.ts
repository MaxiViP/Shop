import { HttpException } from '@nestjs/common';

// Process-local, bounded counters; callers supply the socket IP, never a client header.
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
    for (const [key, limit] of [
      ['global', this.total],
      [ip, this.perIp],
    ] as const) {
      const value = this.attempts.get(key) ?? {
        count: 0,
        until: now + this.minutes * 60_000,
      };
      if (value.count >= limit)
        throw new HttpException(
          `Слишком много попыток. Повторите через ${this.minutes} минут`,
          429,
        );
      value.count++;
      this.attempts.set(key, value);
    }
  }
}
