import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { allowedOrigin } from './admin.config.js';
import { AttemptLimit } from './attempt-limit.js';

@Injectable()
export class AdminLoginGuard implements CanActivate {
  private readonly limit = new AttemptLimit(5, 100, 15);
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers.origin && !allowedOrigin(req.headers.origin))
      throw new ForbiddenException();
    this.limit.check(req.socket.remoteAddress ?? 'unknown');
    return true;
  }
}
