import type { ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';
import { FinanceCtrl, PayoutsCtrl } from '../admin/finance.ctrl.js';
import { ScheduleCtrl } from '../admin/schedule.ctrl.js';
import { AdminOrdersCtrl } from '../admin/orders.ctrl.js';
import { DashboardCtrl } from '../admin/dashboard.ctrl.js';
import { AdminProductsCtrl } from '../admin/products.ctrl.js';
import type { AuthService } from './auth.service.js';
function context() {
  return { switchToHttp: () => ({ getRequest: () => ({
    method: 'GET', headers: {}, cookies: {},
  }) }) } as unknown as ExecutionContext;
}
describe('ADMIN finance route guard', () => {
  beforeEach(() => vi.stubEnv('ADMIN_PHONE', '+79991234567'));
  afterEach(() => vi.unstubAllEnvs());
  it.each(['USER', 'SELLER'] as const)('rejects %s even with the configured phone', async role => {
    const auth = { me: vi.fn().mockResolvedValue({ id: 1, role, phone: '+79991234567' }) } as unknown as AuthService;
    await expect(new AdminGuard(auth).canActivate(context())).rejects.toMatchObject({ status: 403 });
  });
  it('allows only the configured ADMIN account', async () => {
    const auth = { me: vi.fn().mockResolvedValue({ id: 1, role: 'ADMIN', phone: '+79991234567' }) } as unknown as AuthService;
    await expect(new AdminGuard(auth).canActivate(context())).resolves.toBe(true);
  });
});

it('places the ADMIN guard on every internal finance and operations controller', () => {
  for (const controller of [FinanceCtrl, PayoutsCtrl, ScheduleCtrl, AdminOrdersCtrl,
    DashboardCtrl, AdminProductsCtrl]) {
    const guards = Reflect.getMetadata('__guards__', controller) as unknown[] | undefined;
    expect(guards).toContain(AdminGuard);
  }
});
