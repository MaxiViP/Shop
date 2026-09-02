import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { AuthRequest } from './auth.guard.js';
import { StaffGuard } from './staff.guard.js';

function context(role: AuthRequest['user']['role']) {
  return {
    switchToHttp: () => ({
      getRequest: <T>() =>
        ({
          user: { role },
        }) as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

describe('StaffGuard', () => {
  const guard = new StaffGuard();

  it.each(['SELLER', 'ADMIN'] as const)('allows %s', (role) => {
    expect(guard.canActivate(context(role))).toBe(true);
  });

  it('rejects USER', () => {
    expect(() => guard.canActivate(context('USER'))).toThrow(
      ForbiddenException,
    );
  });
});
