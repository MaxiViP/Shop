import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthRequest } from './auth.guard.js';
import { allowedOrigin } from './admin.config.js';

@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!request.user.ownedPoints?.length) throw new ForbiddenException('Нет назначенных торговых точек');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin && !allowedOrigin(request.headers.origin))
      throw new ForbiddenException();
    return true;
  }
}
