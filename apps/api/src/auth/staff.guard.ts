import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthRequest } from './auth.guard.js';

@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();

    if (request.user.role !== 'SELLER' && request.user.role !== 'ADMIN') {
      throw new ForbiddenException();
    }

    return true;
  }
}
