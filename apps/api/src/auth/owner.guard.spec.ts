import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { OwnerGuard } from './owner.guard.js';
function context(ownedPoints: { marketPointId: number }[], origin?: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user: { role: 'USER', ownedPoints }, method: 'PATCH', headers: { origin } }) }) } as ExecutionContext;
}
describe('OwnerGuard', () => {
  it('blocks ordinary buyers and sellers without point assignments', () => {
    expect(() => new OwnerGuard().canActivate(context([]))).toThrow(ForbiddenException);
  });
  it('allows authenticated owners independently of their base role', () => {
    expect(new OwnerGuard().canActivate(context([{ marketPointId: 10 }]))).toBe(true);
  });
  it('rejects cross-origin owner mutations', () => {
    expect(() => new OwnerGuard().canActivate(context([{ marketPointId: 10 }], 'https://untrusted.example'))).toThrow(ForbiddenException);
  });
});
