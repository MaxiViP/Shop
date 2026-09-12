import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { allowedOrigin } from './admin.config.js';
import { AttemptLimit } from './attempt-limit.js';
import { clientIp } from './proxy.js';

@Injectable()
export class MethodGuard implements CanActivate {
  private readonly limit = new AttemptLimit(15, 300, 5);

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers.origin && !allowedOrigin(request.headers.origin))
      throw new ForbiddenException();
    this.limit.check(clientIp(request));
    return true;
  }
}
