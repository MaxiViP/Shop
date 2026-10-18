import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isStaff } from './permissions.js';
import type { AuthRequest } from './auth.guard.js';

@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();

    if (!isStaff(request.user)) {
      throw new ForbiddenException();
    }

    return true;
  }
}
