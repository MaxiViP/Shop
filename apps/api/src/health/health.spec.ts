import { ServiceUnavailableException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import { HealthCtrl } from './health.ctrl.js';

it('keeps liveness separate and rejects readiness when the schema is unavailable', async () => {
  const db = { $queryRaw: vi.fn().mockRejectedValue(new Error('private database details')) } as unknown as DbService;
  const health = new HealthCtrl(db);
  expect(health.check()).toEqual({ ok: true });
  await expect(health.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  try { await health.ready(); } catch (error) {
    expect((error as ServiceUnavailableException).getResponse()).toEqual({ ok: false, database: false });
  }
});
