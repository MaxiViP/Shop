import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthRequest } from './auth.guard.js';
import { AuthService, SID } from './auth.service.js';
import { adminPhone, allowedOrigin } from './admin.config.js';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const user = await this.auth.me(request.cookies?.[SID]);
    if (!user || user.role !== 'ADMIN' || user.phone !== adminPhone()) {
      throw new ForbiddenException();
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin &&
      !allowedOrigin(request.headers.origin)
    )
      throw new ForbiddenException();
    request.user = user;
    return true;
  }
}
